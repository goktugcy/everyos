import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { Database } from "@everyos/database";
import type { SecretBox } from "@everyos/security";
import type { BackupEncryptionView } from "@everyos/shared";
import { z } from "zod";
import { rechunk } from "../../http/streams.ts";
import { invalidBackup } from "./backup-store.ts";

/*
 * Passphrase-encrypted backups (docs/backups.md). A file is
 *
 *   "EOSENC01" | uint32 header length | header JSON | chunk… (ciphertext + 16-byte tag)
 *
 * The passphrase gives a key-encryption key through scrypt; it wraps a random data key per file.
 * The data key encrypts 1 MiB chunks with AES-256-GCM, each nonce carrying the chunk's index
 * and a final-chunk flag, and every chunk authenticates the header: chunks cannot be reordered,
 * dropped, truncated or moved to another file.
 */

export const ENCRYPTED_EXTENSION = ".eosbak";
const MAGIC = Buffer.from("EOSENC01", "ascii");
const CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const WRAP_AAD = Buffer.from("everyos-backup/key-wrap/v1", "ascii");
const SETTINGS_KEY = "backups.encryption";
const SEAL_CONTEXT = "backups:encryption:v1";

export const PASSPHRASE_MIN_LENGTH = 12;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** About 128 MiB and a second on a Raspberry Pi 4 per derivation. */
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

/** The key-encryption key derived from the passphrase, with what derived it. */
export interface PassphraseKey {
  kek: Buffer;
  salt: Buffer;
  params: ScryptParams;
}

const HeaderSchema = z.strictObject({
  format: z.literal("everyos-encrypted-backup"),
  version: z.literal(1),
  backupId: z.string().regex(/^\d{8}-\d{6}-[a-f0-9]{6}$/),
  createdAt: z.number().int().nonnegative(),
  everyosVersion: z.string().max(64),
  hostname: z.string().max(255),
  /** The server secret travels inside, so another machine restores with the passphrase only. */
  includesKey: z.boolean(),
  plaintextSize: z.number().int().nonnegative(),
  chunkSize: z.literal(CHUNK_BYTES),
  kdf: z.strictObject({
    name: z.literal("scrypt"),
    N: z
      .number()
      .int()
      .min(2 ** 14)
      .max(2 ** 20),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
    salt: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  }),
  wrap: z.strictObject({
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    key: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
  }),
  noncePrefix: z.string().regex(/^[A-Za-z0-9_-]{10}$/),
});
export type EncryptedHeader = z.infer<typeof HeaderSchema>;

export class PassphraseError extends Error {}

export function derivePassphraseKey(
  passphrase: string,
  salt: Buffer = randomBytes(16),
  params: ScryptParams = SCRYPT_PARAMS,
): Promise<PassphraseKey> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize("NFC"),
      salt,
      32,
      { ...params, maxmem: 256 * params.N * params.r },
      (error, kek) => (error ? reject(error) : resolve({ kek, salt, params })),
    );
  });
}

export function looksEncrypted(head: Uint8Array): boolean {
  return head.length >= MAGIC.length && MAGIC.equals(Buffer.from(head.subarray(0, MAGIC.length)));
}

const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK_BYTES));

function nonce(prefix: Buffer, index: number, final: boolean): Buffer {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0, 0, 7);
  value.writeUInt32BE(index, 7);
  value[11] = final ? 1 : 0;
  return value;
}

/**
 * Prepares an encrypted copy of `plaintextSize` bytes: its exact size up front (for
 * Content-Length and multipart uploads) and a generator that encrypts the plaintext.
 */
export function encryptBackup(
  key: PassphraseKey,
  meta: Pick<EncryptedHeader, "backupId" | "createdAt" | "everyosVersion" | "hostname"> & {
    includesKey: boolean;
  },
  plaintextSize: number,
): { size: number; encrypt: (source: AsyncIterable<Uint8Array>) => AsyncGenerator<Buffer> } {
  const dataKey = randomBytes(32);
  const wrapNonce = randomBytes(12);
  const wrapper = createCipheriv("aes-256-gcm", key.kek, wrapNonce);
  wrapper.setAAD(WRAP_AAD);
  const wrapped = Buffer.concat([wrapper.update(dataKey), wrapper.final(), wrapper.getAuthTag()]);
  const noncePrefix = randomBytes(7);
  const header: EncryptedHeader = {
    format: "everyos-encrypted-backup",
    version: 1,
    ...meta,
    plaintextSize,
    chunkSize: CHUNK_BYTES,
    kdf: { name: "scrypt", ...key.params, salt: key.salt.toString("base64url") },
    wrap: { nonce: wrapNonce.toString("base64url"), key: wrapped.toString("base64url") },
    noncePrefix: noncePrefix.toString("base64url"),
  };
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const prefix = Buffer.concat([MAGIC, length, json]);
  const aad = createHash("sha256").update(prefix).digest();
  const chunks = chunkCount(plaintextSize);

  async function* encrypt(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
    yield prefix;
    let index = 0;
    let total = 0;
    const seal = (plain: Buffer) => {
      const final = index === chunks - 1;
      const cipher = createCipheriv("aes-256-gcm", dataKey, nonce(noncePrefix, index, final));
      cipher.setAAD(aad);
      const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      index++;
      return sealed;
    };
    for await (const plain of rechunk(source, CHUNK_BYTES)) {
      total += plain.length;
      if (total > plaintextSize || index >= chunks)
        throw new Error("The backup grew while it was being encrypted");
      yield seal(plain);
    }
    if (total !== plaintextSize) throw new Error("The backup shrank while it was being encrypted");
    if (index === 0) yield seal(Buffer.alloc(0));
  }

  return { size: prefix.length + plaintextSize + chunks * TAG_BYTES, encrypt };
}

/** Reads the header from the first bytes of an encrypted file (null when more bytes are needed). */
export function readEncryptedHeader(
  head: Buffer,
): { header: EncryptedHeader; prefix: Buffer } | null {
  if (head.length < MAGIC.length + 4) return null;
  if (!looksEncrypted(head)) throw invalidBackup("encrypted-format");
  const length = head.readUInt32BE(MAGIC.length);
  if (length > MAX_HEADER_BYTES) throw invalidBackup("encrypted-header");
  if (head.length < MAGIC.length + 4 + length) return null;
  const prefix = head.subarray(0, MAGIC.length + 4 + length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(prefix.subarray(MAGIC.length + 4).toString("utf8"));
  } catch {
    throw invalidBackup("encrypted-header");
  }
  const result = HeaderSchema.safeParse(parsed);
  if (!result.success) throw invalidBackup("encrypted-header");
  return { header: result.data, prefix: Buffer.from(prefix) };
}

/** Size of an encrypted file with this header, which must match the file's real size. */
export function encryptedFileSize(header: EncryptedHeader, prefix: Buffer): number {
  return prefix.length + header.plaintextSize + chunkCount(header.plaintextSize) * TAG_BYTES;
}

/** The file's data key from the passphrase; a wrong passphrase throws PassphraseError. */
export async function unwrapDataKey(header: EncryptedHeader, passphrase: string): Promise<Buffer> {
  const { kek } = await derivePassphraseKey(
    passphrase,
    Buffer.from(header.kdf.salt, "base64url"),
    header.kdf,
  );
  const wrapped = Buffer.from(header.wrap.key, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    kek,
    Buffer.from(header.wrap.nonce, "base64url"),
  );
  decipher.setAAD(WRAP_AAD);
  decipher.setAuthTag(wrapped.subarray(32));
  try {
    return Buffer.concat([decipher.update(wrapped.subarray(0, 32)), decipher.final()]);
  } catch {
    throw new PassphraseError("The passphrase does not open this backup");
  }
}

/** Decrypts the bytes after the header; any tampering or truncation fails the whole stream. */
export async function* decryptBackup(
  source: AsyncIterable<Uint8Array>,
  header: EncryptedHeader,
  prefix: Buffer,
  dataKey: Buffer,
): AsyncGenerator<Buffer> {
  const aad = createHash("sha256").update(prefix).digest();
  const noncePrefix = Buffer.from(header.noncePrefix, "base64url");
  const chunks = chunkCount(header.plaintextSize);
  let index = 0;
  for await (const sealed of rechunk(source, CHUNK_BYTES + TAG_BYTES)) {
    const final = index === chunks - 1;
    const expected = final ? header.plaintextSize - index * CHUNK_BYTES : CHUNK_BYTES;
    if (index >= chunks || sealed.length !== expected + TAG_BYTES)
      throw invalidBackup("encrypted-length");
    const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce(noncePrefix, index, final));
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw invalidBackup("encrypted-tampered");
    }
    index++;
    if (plain.length) yield plain;
  }
  if (index !== chunks) throw invalidBackup("encrypted-length");
}

/* ---------------------------------------------------------- the passphrase */

interface StoredSetting {
  sealed: string;
  setAt: number;
  setBy: string | null;
}

interface SealedKey {
  kek: string;
  salt: string;
  N: number;
  r: number;
  p: number;
}

function stored(db: Database): StoredSetting | null {
  const row = db.get<{ value: string }>(
    "SELECT value FROM instance_settings WHERE key = ?",
    SETTINGS_KEY,
  );
  return row ? (JSON.parse(row.value) as StoredSetting) : null;
}

export function encryptionView(db: Database): BackupEncryptionView {
  const setting = stored(db);
  return {
    configured: setting !== null,
    setAt: setting?.setAt ?? null,
    setBy: setting?.setBy ?? null,
  };
}

/** The stored key-encryption key, so scheduled and off-site copies need nobody present. */
export function readPassphraseKey(db: Database, secrets: SecretBox): PassphraseKey | null {
  const setting = stored(db);
  if (!setting) return null;
  const key = JSON.parse(secrets.open(setting.sealed, SEAL_CONTEXT)) as SealedKey;
  return {
    kek: Buffer.from(key.kek, "base64url"),
    salt: Buffer.from(key.salt, "base64url"),
    params: { N: key.N, r: key.r, p: key.p },
  };
}

export function writePassphraseKey(
  db: Database,
  secrets: SecretBox,
  key: PassphraseKey,
  setBy: string,
  now: number,
): void {
  const sealed: SealedKey = {
    kek: key.kek.toString("base64url"),
    salt: key.salt.toString("base64url"),
    ...key.params,
  };
  const setting: StoredSetting = {
    sealed: secrets.seal(JSON.stringify(sealed), SEAL_CONTEXT),
    setAt: now,
    setBy,
  };
  db.run(
    `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SETTINGS_KEY,
    JSON.stringify(setting),
    now,
  );
}

/** Forgets the passphrase: no more encrypted downloads or off-site copies until a new one. */
export function clearPassphraseKey(db: Database): void {
  db.run("DELETE FROM instance_settings WHERE key = ?", SETTINGS_KEY);
}

/** Whether `passphrase` is the one set now (for "do I still remember it?"). */
export async function passphraseMatches(key: PassphraseKey, passphrase: string): Promise<boolean> {
  const candidate = await derivePassphraseKey(passphrase, key.salt, key.params);
  return timingSafeEqual(candidate.kek, key.kek);
}
