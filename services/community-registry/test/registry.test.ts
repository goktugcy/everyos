import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import {
  CommunityClient,
  communityOrigin,
  loadCommunityToken,
  saveCommunityToken,
} from "../../../packages/app-cli/src/community.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePublisherKeys, packDirectory, sha256Hex, signPackage } from "@everyos/app-package";
import { communityEnrollmentStatement, verifyRegistryIndex } from "@everyos/app-registry";
import { inspectCommunityDeployment } from "../../../scripts/community-deployment.ts";
import { COMMUNITY_ORIGIN } from "../../../scripts/community-release-gate.ts";

const owner = generatePublisherKeys(),
  publisher = generatePublisherKeys();
const adminToken = "test-admin-" + "a".repeat(40);
const publisherId = "io.github.alice";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=",
  "base64",
);
let mf: Miniflare, dir: string, developerToken: string;
let workerSource: string;
let packageHash = "",
  imageHash = "",
  submissionId = "";
const request = async (path: string, method = "GET", body?: unknown, credential?: string) => {
  const response = await mf.dispatchFetch(`https://registry.test${path}`, {
    method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as Record<string, unknown>;
  return { status: response.status, data };
};
async function invitation(id = publisherId, recovery = false) {
  const response = await request(
    "/admin/invitations",
    "POST",
    {
      publisherId: id,
      name: "Alice",
      email: "alice@example.test",
      emailVerified: true,
      reason: "Email and namespace verified by operator",
      recovery,
    },
    adminToken,
  );
  expect(response.status).toBe(201);
  return String(response.data.invitation);
}
async function enroll(invite: string, id = publisherId, key = publisher) {
  const input = { publisherId: id, invitation: invite, publicKey: key.publicKey };
  return request("/v1/enroll", "POST", {
    ...input,
    proof: sign(null, communityEnrollmentStatement(input), key.privateKey).toString("base64"),
  });
}
async function makePackage(
  version = "1.0.0",
  html = '<!doctype html><div id="app"></div>',
  locale?: Record<string, unknown>,
) {
  const appDir = await mkdtemp(join(dir, "app-"));
  const manifest = {
    manifestVersion: 1,
    id: `${publisherId}.notes`,
    name: "Notes",
    version,
    description: "Test notes app",
    entry: "index.html",
    icon: "icon.png",
    category: "productivity",
    permissions: [],
    window: {
      defaultWidth: 800,
      defaultHeight: 600,
      minWidth: 320,
      minHeight: 240,
      instances: "single",
    },
    widgets: [],
    sdk: "^0.1.0",
    publisher: { id: publisherId, name: "Alice" },
    ...(locale ? { locales: { default: "en", supported: ["en"], path: "locales" } } : {}),
  };
  await writeFile(join(appDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(appDir, "index.html"), html);
  await writeFile(join(appDir, "icon.png"), png);
  if (locale) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(appDir, "locales"));
    await writeFile(join(appDir, "locales/en.json"), JSON.stringify(locale));
  }
  const packed = await packDirectory(appDir);
  const bytes = packed.bytes;
  const digest = { appId: manifest.id, version, sha256: sha256Hex(bytes), size: bytes.length };
  return { bytes, digest, signature: signPackage(digest, publisher.privateKey), dir: appDir };
}
async function upload(pkg: Awaited<ReturnType<typeof makePackage>>, signature = pkg.signature) {
  const query = new URLSearchParams({
    appId: pkg.digest.appId,
    version: pkg.digest.version,
    signature,
  });
  const response = await mf.dispatchFetch(
    `https://registry.test/v1/artifacts/package?${query.toString()}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${developerToken}` },
      body: pkg.bytes,
    },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "everyos-community-"));
  const bundled = await build({
    entryPoints: [join(import.meta.dirname, "../src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2024",
    write: false,
    external: ["node:*"],
    sourcemap: false,
  });
  workerSource = bundled.outputFiles[0]!.text;
  mf = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "community-test",
          compatibilityDate: "2026-10-25",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: workerSource } },
          },
          env: {
            ADMIN_TOKEN: { type: "text", value: adminToken },
            REGISTRY_PRIVATE_KEY: { type: "text", value: owner.privateKey },
            PUBLIC_ORIGIN: { type: "text", value: "https://registry.test" },
            ENVIRONMENT: { type: "text", value: "local" },
            DB: { type: "d1" },
            ARTIFACTS: { type: "r2" },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB");
  const migration = await readFile(
    join(import.meta.dirname, "../migrations/0001_registry.sql"),
    "utf8",
  );
  await db.exec(migration.split("\n").join(" "));
});
afterAll(async () => {
  await mf?.dispose();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("community registry in real workerd with D1 and R2", () => {
  it("verifies a fresh production-configured deployment only after its first real catalog publication", async () => {
    const production = new Miniflare({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "community-production-inspection-test",
            compatibilityDate: "2026-10-25",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "index.js",
              modules: { "index.js": { type: "esm", contents: workerSource } },
            },
            env: {
              ADMIN_TOKEN: { type: "text", value: adminToken },
              REGISTRY_PRIVATE_KEY: { type: "text", value: owner.privateKey },
              PUBLIC_ORIGIN: { type: "text", value: COMMUNITY_ORIGIN },
              ENVIRONMENT: { type: "text", value: "production" },
              DB: { type: "d1" },
              ARTIFACTS: { type: "r2" },
            },
          },
        },
      ],
    });
    try {
      const db = await production.getD1Database("DB");
      const migration = await readFile(
        join(import.meta.dirname, "../migrations/0001_registry.sql"),
        "utf8",
      );
      await db.exec(migration.split("\n").join(" "));
      const fetcher = {
        get: async (url: string, maxBytes = 512 * 1024) => {
          expect(new URL(url).origin).toBe(COMMUNITY_ORIGIN);
          const response = await production.dispatchFetch(url);
          if (response.status !== 200) throw new Error("Unpublished deployment");
          const body = Buffer.from(await response.arrayBuffer());
          expect(body.length).toBeLessThanOrEqual(maxBytes);
          return body;
        },
      };
      await expect(inspectCommunityDeployment(owner.publicKey, { fetcher })).rejects.toMatchObject({
        check: "signed-catalog",
      });
      const published = await production.dispatchFetch(`${COMMUNITY_ORIGIN}/admin/publish`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(published.status).toBe(200);
      expect(await inspectCommunityDeployment(owner.publicKey, { fetcher })).toMatchObject({
        status: "passed",
        lifecycleAcceptance: "required",
        catalog: { apps: 0, publishers: 0 },
      });
    } finally {
      await production.dispose();
    }
  });

  it("boots and protects all administration and private endpoints", async () => {
    expect((await request("/health")).status).toBe(200);
    expect((await request("/admin/submissions")).status).toBe(401);
    expect((await request("/v1/me")).status).toBe(401);
    expect((await request("/index.json")).status).toBe(503);
    expect((await request("/health?extra=1")).status).toBe(400);
    expect(
      (await request("/admin/invitations", "POST", { publisherId: "dev.everyos" }, adminToken))
        .status,
    ).toBe(400);
  });
  it("requires a verified invitation and key proof, consumes invitations once", async () => {
    const secret = await invitation();
    const input = {
      publisherId,
      invitation: secret,
      publicKey: publisher.publicKey,
      proof: "A".repeat(86) + "==",
    };
    expect((await request("/v1/enroll", "POST", input)).status).toBe(403);
    const result = await enroll(secret);
    expect(result.status).toBe(201);
    developerToken = String(result.data.token);
    expect((await enroll(secret)).status).toBe(403);
    expect((await request("/v1/me", "GET", undefined, developerToken)).data.publisherId).toBe(
      publisherId,
    );
    expect(
      (
        await request(
          "/admin/invitations",
          "POST",
          {
            publisherId: `${publisherId}.nested`,
            name: "Nested",
            email: "a@example.test",
            emailVerified: true,
            reason: "Verified",
          },
          adminToken,
        )
      ).status,
    ).toBe(409);
  });
  it("checks publisher signatures, archive limits, HTML, locales, and image types before accepting", async () => {
    const pkg = await makePackage();
    expect((await upload(pkg, "A".repeat(86) + "==")).status).toBe(403);
    expect((await upload(await makePackage("1.0.1", "<script>alert(1)</script>"))).status).toBe(
      422,
    );
    expect((await upload(await makePackage("1.0.2", undefined, { bad: 12 }))).status).toBe(422);
    const result = await upload(pkg);
    expect(result.status).toBe(201);
    expect(result.data.reviewRequired).toBe(true);
    packageHash = String(result.data.hash);
    expect((await mf.dispatchFetch(`https://registry.test/packages/${packageHash}`)).status).toBe(
      404,
    );
    const image = await mf.dispatchFetch("https://registry.test/v1/artifacts/image", {
      method: "POST",
      headers: { authorization: `Bearer ${developerToken}` },
      body: png,
    });
    expect(image.status).toBe(201);
    imageHash = String(((await image.json()) as { hash: string }).hash);
    const svg = await mf.dispatchFetch("https://registry.test/v1/artifacts/image", {
      method: "POST",
      headers: { authorization: `Bearer ${developerToken}` },
      body: "<svg></svg>",
    });
    expect(svg.status).toBe(422);
    const oversized = await mf.dispatchFetch("https://registry.test/v1/artifacts/image", {
      method: "POST",
      headers: { authorization: `Bearer ${developerToken}`, "content-length": "2097153" },
      body: Buffer.alloc(2097153),
    });
    expect(oversized.status).toBe(413);
  });
  it("rejects signed corrupt archives, identity mismatches, and decompression bombs", async () => {
    const original = await makePackage("2.0.0");
    const corrupt = Buffer.from("not a gzip archive");
    const corruptDigest = { ...original.digest, sha256: sha256Hex(corrupt), size: corrupt.length };
    expect(
      (
        await upload({
          ...original,
          bytes: corrupt,
          digest: corruptDigest,
          signature: signPackage(corruptDigest, publisher.privateKey),
        })
      ).status,
    ).toBe(422);
    const wrongIdentity = { ...original.digest, version: "2.0.1" };
    expect(
      (
        await upload({
          ...original,
          digest: wrongIdentity,
          signature: signPackage(wrongIdentity, publisher.privateKey),
        })
      ).status,
    ).toBe(422);
    await writeFile(join(original.dir, "large.js"), Buffer.alloc(33 * 1024 * 1024, 97));
    const bomb = await packDirectory(original.dir);
    const bombDigest = {
      ...original.digest,
      sha256: sha256Hex(bomb.bytes),
      size: bomb.bytes.length,
    };
    expect(
      (
        await upload({
          ...original,
          bytes: bomb.bytes,
          digest: bombDigest,
          signature: signPackage(bombDigest, publisher.privateKey),
        })
      ).status,
    ).toBe(422);
  });
  it("keeps submissions private and exposes the actual manifest for human review", async () => {
    const result = await request(
      "/v1/submissions",
      "POST",
      { package: packageHash, icon: imageHash, changelog: "First version" },
      developerToken,
    );
    expect(result.status).toBe(201);
    submissionId = String(result.data.id);
    expect(
      (
        await request(
          "/v1/submissions",
          "POST",
          { package: packageHash, icon: imageHash },
          developerToken,
        )
      ).status,
    ).toBe(409);
    const pending = await request("/admin/submissions", "GET", undefined, adminToken);
    expect(pending.data.submissions as unknown[]).toHaveLength(1);
    const download = await mf.dispatchFetch(
      `https://registry.test/admin/submissions/${submissionId}/package/${packageHash}`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(download.status).toBe(200);
    expect(sha256Hex(Buffer.from(await download.arrayBuffer()))).toBe(packageHash);
    expect((await mf.dispatchFetch(`https://registry.test/images/${imageHash}`)).status).toBe(404);
  });
  it("serializes competing reviews and publishes a verifiable immutable version", async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        request(
          `/admin/submissions/${submissionId}/review`,
          "POST",
          { decision: "approved", note: "Reviewed source, license, permissions and assets" },
          adminToken,
        ),
      ),
    );
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    const indexResponse = await mf.dispatchFetch("https://registry.test/index.json");
    expect(indexResponse.status).toBe(200);
    const signed = await indexResponse.text();
    const index = verifyRegistryIndex(signed, owner.publicKey, { official: false });
    expect(index.apps[0]?.versions[0]?.version).toBe("1.0.0");
    expect((await mf.dispatchFetch(`https://registry.test/packages/${packageHash}`)).status).toBe(
      200,
    );
    expect(
      (
        await request(
          "/v1/submissions",
          "POST",
          { package: packageHash, icon: imageHash },
          developerToken,
        )
      ).status,
    ).toBe(409);
  });
  it("rejects with a review note and accepts a corrected submission, then a new update", async () => {
    const uploaded = await upload(await makePackage("1.1.0"));
    expect(uploaded.status).toBe(201);
    const body = {
      package: uploaded.data.hash,
      icon: imageHash,
      screenshots: [imageHash],
      changelog: "Update",
    };
    const first = await request("/v1/submissions", "POST", body, developerToken);
    expect(
      (
        await request(
          `/admin/submissions/${String(first.data.id)}/review`,
          "POST",
          { decision: "rejected", note: "Explain requested permissions" },
          adminToken,
        )
      ).status,
    ).toBe(200);
    const status = await request("/v1/submissions", "GET", undefined, developerToken);
    expect(JSON.stringify(status.data)).toContain("Explain requested permissions");
    const corrected = await request("/v1/submissions", "POST", body, developerToken);
    expect(corrected.status).toBe(201);
    expect(
      (
        await request(
          `/admin/submissions/${String(corrected.data.id)}/review`,
          "POST",
          { decision: "approved", note: "Permissions reviewed" },
          adminToken,
        )
      ).status,
    ).toBe(200);
    const index = verifyRegistryIndex(
      await (await mf.dispatchFetch("https://registry.test/index.json")).text(),
      owner.publicKey,
      { official: false },
    );
    expect(index.apps[0]?.versions).toHaveLength(2);
  });
  it("revokes published versions, blocks downloads, and carries revocations in the signed index", async () => {
    expect(
      (
        await request(
          "/v1/revocations",
          "POST",
          { appId: `${publisherId}.notes`, version: "1.0.0", reason: "Security issue" },
          developerToken,
        )
      ).status,
    ).toBe(200);
    expect((await mf.dispatchFetch(`https://registry.test/packages/${packageHash}`)).status).toBe(
      404,
    );
    const index = verifyRegistryIndex(
      await (await mf.dispatchFetch("https://registry.test/index.json")).text(),
      owner.publicKey,
      { official: false },
    );
    expect(index.revoked[0]?.reason).toBe("Security issue");
    expect(
      (
        await request(
          "/v1/revocations",
          "POST",
          { appId: "io.github.mallory.app", version: "*", reason: "Bad" },
          developerToken,
        )
      ).status,
    ).toBe(403);
  });
  it("accepts abuse reports, limits anonymous submissions and requires operator resolution", async () => {
    const report = {
      appId: `${publisherId}.notes`,
      reason: "Suspicious network access after installation",
    };
    const first = await request("/v1/reports", "POST", report);
    expect(first.status).toBe(201);
    for (let i = 0; i < 4; i++)
      expect((await request("/v1/reports", "POST", report)).status).toBe(201);
    expect((await request("/v1/reports", "POST", report)).status).toBe(429);
    expect(
      (await request("/admin/reports", "GET", undefined, adminToken)).data.reports,
    ).toHaveLength(5);
    expect(
      (
        await request(
          `/admin/reports/${String(first.data.id)}/resolve`,
          "POST",
          { resolution: "Reviewed and revoked affected version" },
          adminToken,
        )
      ).status,
    ).toBe(200);
  });
  it("runs the developer CLI over the local HTTP listener with real private uploads and status", async () => {
    const origin = (await mf.ready).origin;
    const cli = join(import.meta.dirname, "../../../packages/app-cli/src/cli.ts");
    const credentials = join(dir, "credentials.json"),
      key = join(dir, "publisher.key"),
      icon = join(dir, "icon.png"),
      file = join(dir, "notes.eosapp");
    await saveCommunityToken(credentials, origin, developerToken);
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(`${credentials}.key`)).mode & 0o777).toBe(0o600);
    const encrypted = await readFile(credentials, "utf8");
    expect(encrypted).not.toContain(developerToken);
    expect(await loadCommunityToken(credentials, origin)).toBe(developerToken);
    const damaged = JSON.parse(encrypted) as { sealed: string };
    damaged.sealed =
      damaged.sealed.slice(0, 8) +
      (damaged.sealed[8] === "A" ? "B" : "A") +
      damaged.sealed.slice(9);
    await writeFile(credentials, JSON.stringify(damaged));
    await expect(loadCommunityToken(credentials, origin)).rejects.toThrow("could not be decrypted");
    await writeFile(credentials, encrypted);
    await expect(loadCommunityToken(credentials, "https://another.test")).rejects.toThrow(
      "do not match",
    );
    await writeFile(key, publisher.privateKey, { mode: 0o600 });
    await writeFile(icon, png);
    await writeFile(file, (await makePackage("1.2.0")).bytes);
    const run = promisify(execFile);
    const result = await run(
      process.execPath,
      [
        cli,
        "community",
        "submit",
        file,
        "--icon",
        icon,
        "--key",
        key,
        "--token-file",
        credentials,
        "--registry-url",
        origin,
      ],
      { env: { ...process.env, EVERYOS_COMMUNITY_TOKEN: developerToken }, maxBuffer: 1024 * 1024 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "pending" });
    const status = await run(
      process.execPath,
      [cli, "community", "status", "--token-file", credentials, "--registry-url", origin],
      { env: { ...process.env, EVERYOS_COMMUNITY_TOKEN: developerToken }, maxBuffer: 1024 * 1024 },
    );
    expect(status.stdout).toContain("1.2.0");
    expect(status.stdout).not.toContain(developerToken);
    const bob = generatePublisherKeys(),
      invite = await invitation("io.github.bob");
    const bobKey = join(dir, "bob.key"),
      bobToken = join(dir, "bob-token.json");
    await writeFile(bobKey, bob.privateKey, { mode: 0o600 });
    const enrolled = await run(
      process.execPath,
      [
        cli,
        "community",
        "enroll",
        "--publisher-id",
        "io.github.bob",
        "--key",
        bobKey,
        "--token-file",
        bobToken,
        "--registry-url",
        origin,
      ],
      { env: { ...process.env, EVERYOS_COMMUNITY_INVITATION: invite }, maxBuffer: 1024 * 1024 },
    );
    expect(enrolled.stdout).toContain("Enrolled io.github.bob");
    expect(enrolled.stdout).not.toContain(invite);
    const bobClient = new CommunityClient(origin, await loadCommunityToken(bobToken, origin));
    await expect(
      bobClient.request(
        "/v1/submissions",
        "POST",
        JSON.stringify({ package: packageHash, icon: imageHash }),
      ),
    ).rejects.toThrow("artifact-not-owned");
    await expect(bobClient.request("//another.test/v1/me")).rejects.toThrow(
      "configured registry origin",
    );
    expect(() => communityOrigin("http://example.test")).toThrow();
  });
  it("refuses expired invitations and unpublished artifacts whose R2 upload did not complete", async () => {
    const invite = await invitation("io.github.expired");
    const db = await mf.getD1Database("DB");
    await db
      .prepare("UPDATE invitations SET expires_at = 0 WHERE publisher_id = ?")
      .bind("io.github.expired")
      .run();
    expect((await enroll(invite, "io.github.expired", generatePublisherKeys())).status).toBe(403);
    const image = await (await mf.getR2Bucket("ARTIFACTS")).get(`images/${imageHash}`);
    const bytes = await image!.arrayBuffer();
    await (await mf.getR2Bucket("ARTIFACTS")).delete(`images/${imageHash}`);
    const packageForRetry = await upload(await makePackage("1.3.0"));
    expect(packageForRetry.status).toBe(201);
    expect(
      (
        await request(
          "/v1/submissions",
          "POST",
          { package: packageForRetry.data.hash, icon: imageHash },
          developerToken,
        )
      ).status,
    ).toBe(409);
    await (
      await mf.getR2Bucket("ARTIFACTS")
    ).put(`images/${imageHash}`, bytes, { httpMetadata: { contentType: "image/png" } });
  });
  it("retains a valid catalog on missing R2 artifacts, retries publication, and never lowers its sequence", async () => {
    const before = verifyRegistryIndex(
      await (await mf.dispatchFetch("https://registry.test/index.json")).text(),
      owner.publicKey,
      { official: false },
    );
    const bucket = await mf.getR2Bucket("ARTIFACTS");
    const saved = await bucket.get(`packages/${packageHash}`);
    const bytes = await saved!.arrayBuffer();
    await bucket.delete(`packages/${packageHash}`);
    expect((await request("/admin/publish", "POST", {}, adminToken)).status).toBe(202);
    const retained = verifyRegistryIndex(
      await (await mf.dispatchFetch("https://registry.test/index.json")).text(),
      owner.publicKey,
      { official: false },
    );
    expect(retained.sequence).toBe(before.sequence);
    await bucket.put(`packages/${packageHash}`, bytes);
    const refreshed = await Promise.all(
      [1, 2].map(() => request("/admin/publish", "POST", {}, adminToken)),
    );
    expect(refreshed.every((result) => result.status === 200)).toBe(true);
    const latest = verifyRegistryIndex(
      await (await mf.dispatchFetch("https://registry.test/index.json")).text(),
      owner.publicKey,
      { official: false },
    );
    expect(latest.sequence).toBe(
      Math.max(...refreshed.map((result) => Number(result.data.sequence))),
    );
    expect(latest.sequence).toBeGreaterThan(before.sequence);
  });
  it("rotates and recovers scoped tokens without putting credentials in D1 audit records", async () => {
    const rotated = await request("/v1/token", "POST", {}, developerToken);
    expect(rotated.status).toBe(201);
    expect((await request("/v1/me", "GET", undefined, developerToken)).status).toBe(401);
    developerToken = String(rotated.data.token);
    const recovered = await enroll(
      await invitation(publisherId, true),
      publisherId,
      generatePublisherKeys(),
    );
    expect(recovered.status).toBe(201);
    expect((await request("/v1/me", "GET", undefined, developerToken)).status).toBe(401);
    const db = await mf.getD1Database("DB");
    const audit = JSON.stringify((await db.prepare("SELECT * FROM audit").all()).results);
    expect(audit).not.toContain(adminToken);
    expect(audit).not.toContain(developerToken);
    expect(audit).not.toContain(owner.privateKey);
    expect(audit).not.toContain("alice@example.test");
    const stored = JSON.stringify((await db.prepare("SELECT * FROM tokens").all()).results);
    expect(stored).not.toContain(String(recovered.data.token));
  });
  it("refreshes the real signed index and expires credentials through its scheduled handler", async () => {
    const db = await mf.getD1Database("DB");
    await db.prepare("UPDATE registry_state SET expires_at = 0 WHERE id = 1").run();
    const worker = await mf.getWorker();
    const result = await worker.scheduled({ cron: "17 3 * * *" });
    expect(result.outcome).toBe("ok");
    const index = verifyRegistryIndex(
      await (await mf.dispatchFetch("https://registry.test/index.json")).text(),
      owner.publicKey,
      { official: false },
    );
    expect(index.publishers.find((entry) => entry.id === publisherId)?.keys).toHaveLength(2);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM tokens WHERE revoked = 1")
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });
});
