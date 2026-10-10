import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_PREFIX = "v1.";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/**
 * Authenticated encryption (AES-256-GCM) for secrets stored at rest, such as
 * TOTP seeds and application API tokens.
 *
 * The `context` argument is bound as additional authenticated data so a
 * ciphertext cannot be moved to a different row or purpose (for example,
 * copying one user's TOTP secret onto another user).
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new SecretBoxError("SecretBox requires a 256-bit key");
    this.#key = key;
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return VERSION_PREFIX + Buffer.concat([iv, body, tag]).toString("base64url");
  }

  open(sealed: string, context: string): string {
    if (!sealed.startsWith(VERSION_PREFIX)) throw new SecretBoxError("Unsupported secret format");
    const raw = Buffer.from(sealed.slice(VERSION_PREFIX.length), "base64url");
    if (raw.length < IV_LENGTH + TAG_LENGTH) throw new SecretBoxError("Malformed secret");
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(raw.length - TAG_LENGTH);
    const body = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretBoxError(
        "Secret could not be decrypted (wrong key, context or tampered data)",
      );
    }
  }
}
