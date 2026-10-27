import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveKey,
  KeyFileError,
  loadKeyFile,
  randomToken,
  safeEqual,
  SecretBox,
  SecretBoxError,
} from "./index.ts";

const key = Buffer.alloc(32, 7);

describe("SecretBox", () => {
  it("round-trips plaintext bound to a context", () => {
    const box = new SecretBox(key);
    const sealed = box.seal("JBSWY3DPEHPK3PXP", "user:1:totp");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(box.open(sealed, "user:1:totp")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("produces a different ciphertext for each seal", () => {
    const box = new SecretBox(key);
    expect(box.seal("same", "ctx")).not.toBe(box.seal("same", "ctx"));
  });

  it("rejects a ciphertext moved to another context", () => {
    const box = new SecretBox(key);
    const sealed = box.seal("secret", "user:1:totp");
    expect(() => box.open(sealed, "user:2:totp")).toThrow(SecretBoxError);
  });

  it("rejects tampered data and wrong keys", () => {
    const box = new SecretBox(key);
    const sealed = box.seal("secret", "ctx");
    // Changing base64 text can touch only unused padding bits, leaving authenticated bytes intact.
    const changed = Buffer.from(sealed.slice("v1.".length), "base64url");
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    const tampered = "v1." + changed.toString("base64url");
    expect(() => box.open(tampered, "ctx")).toThrow(SecretBoxError);
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed, "ctx")).toThrow(SecretBoxError);
  });

  it("requires a 256-bit key", () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow(SecretBoxError);
  });
});

describe("crypto helpers", () => {
  it("preserves the version-1 key derivation across the product rename", () => {
    expect(deriveKey(key, "otuken/secret-box/v1").toString("hex")).toBe(
      "067f8b11d6ae259cd0401cf3b8bcccad729b4896c02d85d4ea1ea7af0931fe2a",
    );
  });

  it("derives distinct, deterministic subkeys per purpose", () => {
    const a1 = deriveKey(key, "otuken/a/v1");
    const a2 = deriveKey(key, "otuken/a/v1");
    const b = deriveKey(key, "otuken/b/v1");
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
    expect(a1).toHaveLength(32);
  });

  it("compares strings safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("generates url-safe random tokens", () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });
});

describe("loadKeyFile", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "everyos-key-"));

  it("creates a key with restrictive permissions and reloads it", () => {
    const path = join(dir(), "nested", "secret.key");
    const created = loadKeyFile(path, { create: true, enforcePermissions: true });
    expect(created).toHaveLength(32);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadKeyFile(path, { create: false, enforcePermissions: true });
    expect(loaded.equals(created)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(created.toString("base64url"));
  });

  it("fails when the key is missing and creation is not allowed", () => {
    expect(() =>
      loadKeyFile(join(dir(), "missing.key"), { create: false, enforcePermissions: true }),
    ).toThrow(KeyFileError);
  });

  it("rejects world-readable keys when enforcing permissions", () => {
    if (process.platform === "win32") return;
    const path = join(dir(), "open.key");
    writeFileSync(path, Buffer.alloc(32, 1).toString("base64url"));
    chmodSync(path, 0o644);
    expect(() => loadKeyFile(path, { create: false, enforcePermissions: true })).toThrow(
      /too open/,
    );
    expect(loadKeyFile(path, { create: false, enforcePermissions: false })).toHaveLength(32);
  });

  it("rejects malformed key material", () => {
    const path = join(dir(), "bad.key");
    writeFileSync(path, "short", { mode: 0o600 });
    expect(() => loadKeyFile(path, { create: false, enforcePermissions: true })).toThrow(
      /32 base64url/,
    );
  });
});
