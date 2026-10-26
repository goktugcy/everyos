import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { generatePublisherKeys, keyFingerprint } from "../packages/app-package/src/index.ts";
import { signRegistryIndex } from "../packages/app-registry/src/index.ts";
import { CommunityDeploymentError, inspectCommunityDeployment } from "./community-deployment.ts";
import { checkCommunityRelease, COMMUNITY_ORIGIN } from "./community-release-gate.ts";

const keys = generatePublisherKeys();
const other = generatePublisherKeys();
const now = Date.parse("2026-10-26T00:00:00Z");
const index = {
  format: "everyos-app-registry" as const,
  schemaVersion: 1 as const,
  registry: { id: "community", name: "Community" },
  sequence: 3,
  publishedAt: now - 1000,
  expiresAt: now + 60000,
  publishers: [],
  apps: [],
  revoked: [],
};
const signed = signRegistryIndex(index, keys.privateKey, { official: false });
function fixture(changes: Record<string, unknown> = {}) {
  const replies: Record<string, unknown> = {
    "/health": { status: "ok", environment: "production" },
    "/.well-known/everyos-registry": {
      publicKey: keys.publicKey,
      fingerprint: keyFingerprint(keys.publicKey),
      indexUrl: `${COMMUNITY_ORIGIN}/index.json`,
      environment: "production",
    },
    "/registry.pub": keys.publicKey,
    "/index.json": signed,
    ...changes,
  };
  return {
    get: vi.fn((url: string) => {
      expect(new URL(url).origin).toBe(COMMUNITY_ORIGIN);
      const value = replies[new URL(url).pathname];
      if (value === undefined) throw new Error("Unexpected endpoint");
      return Promise.resolve(
        Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
      );
    }),
  };
}

describe("Read-only production community deployment verification", () => {
  it("binds production identity and the current signed catalog to an independent public key", async () => {
    const fetcher = fixture();
    const report = await inspectCommunityDeployment(keys.publicKey, { fetcher, now });
    expect(report).toMatchObject({
      status: "passed",
      registryFingerprint: keyFingerprint(keys.publicKey),
      lifecycleAcceptance: "required",
      catalog: { sequence: 3, apps: 0, sha256: createHash("sha256").update(signed).digest("hex") },
    });
    expect(fetcher.get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/health",
      "/.well-known/everyos-registry",
      "/registry.pub",
      "/index.json",
    ]);
    expect(() =>
      checkCommunityRelease(
        { url: `${COMMUNITY_ORIGIN}/index.json`, publicKey: keys.publicKey },
        report,
        "0.1.37",
        now,
      ),
    ).toThrow();
  });

  it.each([keys.privateKey, "invalid-public-key"])(
    "rejects a non-public trust input before any request",
    async (input) => {
      const fetcher = fixture();
      await expect(inspectCommunityDeployment(input, { fetcher, now })).rejects.toMatchObject({
        check: "trusted-public-key",
      });
      expect(fetcher.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "ok", environment: "local" },
    { status: "failed", environment: "production" },
    { status: "ok", environment: "production", unexpected: true },
  ])("refuses an unhealthy, non-production or malformed service", async (health) => {
    const fetcher = fixture({ "/health": health });
    await expect(
      inspectCommunityDeployment(keys.publicKey, { fetcher, now }),
    ).rejects.toMatchObject({ check: "service-health" });
    expect(fetcher.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    { publicKey: other.publicKey },
    { fingerprint: keyFingerprint(other.publicKey) },
    { indexUrl: "https://example.com/index.json" },
    { environment: "local" },
  ])("refuses identity/key/origin drift before fetching the catalog", async (changed) => {
    const fetcher = fixture({
      "/.well-known/everyos-registry": {
        publicKey: keys.publicKey,
        fingerprint: keyFingerprint(keys.publicKey),
        indexUrl: `${COMMUNITY_ORIGIN}/index.json`,
        environment: "production",
        ...changed,
      },
    });
    await expect(
      inspectCommunityDeployment(keys.publicKey, { fetcher, now }),
    ).rejects.toMatchObject({ check: "registry-identity" });
    expect(fetcher.get).toHaveBeenCalledTimes(2);
  });

  it.each([other.publicKey, keys.privateKey])(
    "refuses a replaced or private /registry.pub",
    async (publicKey) => {
      const fetcher = fixture({ "/registry.pub": publicKey });
      await expect(
        inspectCommunityDeployment(keys.publicKey, { fetcher, now }),
      ).rejects.toMatchObject({ check: "published-public-key" });
      expect(fetcher.get).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    signRegistryIndex(index, other.privateKey, { official: false }),
    signRegistryIndex({ ...index, expiresAt: now - 1 }, keys.privateKey, { official: false }),
    signRegistryIndex({ ...index, registry: { id: "private", name: "Private" } }, keys.privateKey, {
      official: false,
    }),
    "not-json",
  ])("refuses an invalid, expired or unrelated signed catalog", async (catalog) => {
    await expect(
      inspectCommunityDeployment(keys.publicKey, {
        fetcher: fixture({ "/index.json": catalog }),
        now,
      }),
    ).rejects.toMatchObject({ check: "signed-catalog" });
  });

  it("redacts unexpected transport/body errors to a fixed failed check", async () => {
    const fetcher = {
      get: () =>
        Promise.reject<Buffer>(new Error("Do not expose credential-bearing response bodies")),
    };
    await expect(inspectCommunityDeployment(keys.publicKey, { fetcher, now })).rejects.toEqual(
      new CommunityDeploymentError("service-health"),
    );
  });

  it("the real CLI prints help or a bounded failure without requiring credentials or network", async () => {
    const run = promisify(execFile);
    const script = new URL("./community-inspect.ts", import.meta.url).pathname;
    const help = await run(process.execPath, [script, "--help", "--public-key", "/missing"]);
    expect(help.stdout).toContain("Read-only HTTPS");
    const directory = await mkdtemp(join(tmpdir(), "everyos-community-inspect-"));
    try {
      const file = join(directory, "ephemeral-test.key");
      await writeFile(file, keys.privateKey, { mode: 0o600 });
      const failure = await run(process.execPath, [script, "--public-key", file]).catch(
        (error) => error as { code: number; stdout: string; stderr: string },
      );
      expect(failure).toMatchObject({ code: 1, stdout: "" });
      expect(failure.stderr.trim()).toBe(
        JSON.stringify({ status: "failed", check: "trusted-public-key" }),
      );
      expect(failure.stderr).not.toContain(keys.privateKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
