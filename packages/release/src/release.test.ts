import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareVersions, verifyRelease, ReleaseManifestSchema } from "./manifest.ts";
import { download, isPublicReleaseAddress } from "./transport.ts";
import { SelfUpdateManager } from "./manager.ts";
import { ReleaseInstallSchema } from "@everyos/shared/schemas";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
function signed(changes: Record<string, unknown> = {}) {
  const manifest = {
    format: "everyos-release",
    version: "0.2.0",
    minVersion: "0.1.0",
    schemaVersion: 10,
    publishedAt: 1000,
    expiresAt: 10000,
    notes: "Release notes",
    artifacts: {
      arm64: { file: "everyos_0.2.0_arm64.deb", size: 100, sha256: "a".repeat(64) },
      amd64: { file: "everyos_0.2.0_amd64.deb", size: 100, sha256: "b".repeat(64) },
    },
    ...changes,
  };
  const payload = Buffer.from(JSON.stringify(manifest));
  return JSON.stringify({
    payload: payload.toString("base64"),
    signature: sign(null, payload, keys.privateKey).toString("base64"),
  });
}
describe("verified releases", () => {
  it("verifies exact payload bytes, identity and validity window", () => {
    expect(verifyRelease(signed(), publicKey, 5000).version).toBe("0.2.0");
    expect(() => verifyRelease(signed(), publicKey, 11000)).toThrow(/expired/);
    expect(() => verifyRelease(signed({ publishedAt: 99999999 }), publicKey, 5000)).toThrow(
      /timestamp/,
    );
    const envelope = JSON.parse(signed()) as { payload: string; signature: string };
    envelope.payload = Buffer.from(
      Buffer.from(envelope.payload, "base64").toString().replace("Release notes", "Tampered notes"),
    ).toString("base64");
    expect(() => verifyRelease(JSON.stringify(envelope), publicKey, 5000)).toThrow(/signature/);
    const wrong = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    expect(() => verifyRelease(signed(), wrong, 5000)).toThrow(/signature/);
    expect(() => verifyRelease(signed({ version: "0.3.0" }), publicKey, 5000)).toThrow(/identity/);
  });
  it("rejects extra instructions, oversized packages and non-stable versions", () => {
    expect(() => verifyRelease(signed({ command: "curl | sh" }), publicKey, 5000)).toThrow();
    expect(ReleaseManifestSchema.safeParse({}).success).toBe(false);
    expect(compareVersions("0.10.0", "0.2.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareVersions("1.0.0;id", "1.0.0")).toThrow();
    expect(
      ReleaseInstallSchema.safeParse({
        version: "0.2.0",
        backupId: "20261011-200000-aabbcc",
        confirm: true,
        url: "https://attacker.invalid",
      }).success,
    ).toBe(false);
  });
  it("rejects private, reserved and IPv6 transition addresses before connecting", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "192.0.2.1",
      "::1",
      "::ffff:127.0.0.1",
      "64:ff9b::a00:1",
      "2002:7f00:1::",
      "2001:db8::1",
    ])
      expect(isPublicReleaseAddress(address)).toBe(false);
    expect(isPublicReleaseAddress("8.8.8.8")).toBe(true);
    expect(isPublicReleaseAddress("2606:4700:4700::1111")).toBe(true);
    await expect(download(new URL("https://127.0.0.1/release.json"), 100)).rejects.toThrow(
      /public/,
    );
    await expect(download(new URL("http://example.com/release.json"), 100)).rejects.toThrow(
      /HTTPS/,
    );
  });
  it("never queues a host update in development", async () => {
    const manager = new SelfUpdateManager("development");
    expect(await manager.status(true)).toMatchObject({
      reason: "development-mode",
      job: null,
      available: null,
    });
    await expect(
      manager.install(
        { version: "0.2.0", backupId: "20261011-200000-aabbcc", confirm: true },
        { userId: "a", username: "admin" },
      ),
    ).rejects.toThrow(/production/);
  });
});
