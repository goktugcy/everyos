import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Cryptographically secure random token, base64url encoded. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

/**
 * Constant-time string comparison. Both inputs are hashed first so the
 * comparison time does not leak the length of the expected value.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/**
 * Derives an independent 256-bit subkey for one purpose from the host master
 * key (HKDF-SHA256). Every purpose string must be unique and versioned, e.g.
 * `otuken/secret-box/v1`.
 */
export function deriveKey(masterKey: Buffer, purpose: string, length = 32): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.from("otuken-hkdf-salt-v1"), Buffer.from(purpose), length),
  );
}
