import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (built into Node, no native addon required).
 *
 * Default parameters follow the OWASP Password Storage Cheat Sheet option
 * N=2^16 (64 MiB), r=8, p=2. The encoded form is self-describing so the
 * parameters can be raised later; `verifyPassword` reports `needsRehash`
 * when a stored hash uses weaker parameters than the current defaults.
 *
 * Encoded format: `$scrypt$v=1$ln=<log2N>,r=<r>,p=<p>$<salt>$<hash>` (base64url).
 */
export interface ScryptParams {
  log2N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { log2N: 16, r: 8, p: 2 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = "$scrypt$v=1$";

function deriveScrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.log2N;
  const options: ScryptOptions = {
    N,
    r: params.r,
    p: params.p,
    // scrypt needs 128 * N * r bytes; leave headroom for bookkeeping.
    maxmem: 128 * N * params.r + 32 * 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(normalizePassword(password), salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** NIST SP 800-63B recommends Unicode normalization before hashing. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveScrypt(password, salt, params);
  return `${PREFIX}ln=${params.log2N},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  if (!encoded.startsWith(PREFIX)) return null;
  const [paramPart, saltPart, keyPart, ...rest] = encoded.slice(PREFIX.length).split("$");
  if (!paramPart || !saltPart || !keyPart || rest.length > 0) return null;
  const match = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(paramPart);
  if (!match) return null;
  const params = { log2N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (params.log2N < 10 || params.log2N > 22 || params.r < 1 || params.p < 1) return null;
  const salt = Buffer.from(saltPart, "base64url");
  const key = Buffer.from(keyPart, "base64url");
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params, salt, key };
}

export interface PasswordVerification {
  valid: boolean;
  needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  encoded: string,
  current: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<PasswordVerification> {
  const parsed = parseHash(encoded);
  if (!parsed) return { valid: false, needsRehash: false };
  const candidate = await deriveScrypt(password, parsed.salt, parsed.params);
  const valid = timingSafeEqual(candidate, parsed.key);
  const needsRehash =
    valid &&
    (parsed.params.log2N < current.log2N ||
      parsed.params.r < current.r ||
      parsed.params.p < current.p);
  return { valid, needsRehash };
}

/**
 * Burns roughly the same CPU time as a real verification. Used when a login
 * names an unknown user so response timing does not reveal which usernames
 * exist.
 */
export function createDummyVerifier(
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): () => Promise<void> {
  let dummyHash: Promise<string> | null = null;
  return async () => {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"), params);
    await verifyPassword("everyos-dummy-password", await dummyHash, params);
  };
}
