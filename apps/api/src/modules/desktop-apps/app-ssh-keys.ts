import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SshKey, SshKeyType } from "@everyos/app-sdk/protocol";
import type { Database } from "@everyos/database";
import type { SecretBox } from "@everyos/security";
import { ApiError, notFound } from "../../http/errors.ts";

/*
 * Each person's SSH keys for apps holding secrets:ssh (docs/app-sdk/ssh-keys.md). Keys are made
 * with Node's own cryptography and written in OpenSSH's formats here; private keys are sealed with
 * the server secret. Only an export the person confirmed reveals a private key.
 */

const run = promisify(execFile);
const MAX_KEYS = 100;
const privateContext = (userId: string, id: string) => `desktop-app-ssh:${userId}:${id}`;

const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};
const string = (value: Buffer | string) => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([u32(bytes.length), bytes]);
};
/** An SSH mpint: big-endian, minimal, with a zero byte before a set high bit. */
const mpint = (value: Buffer) => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  return string(trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};
const b64url = (value: string | undefined) => Buffer.from(value ?? "", "base64url");

/** Reads the `string`s of an SSH wire blob, refusing anything truncated. */
function readStrings(blob: Buffer, count: number): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > blob.length) throw new Error("truncated");
    const length = blob.readUInt32BE(offset);
    offset += 4;
    if (offset + length > blob.length) throw new Error("truncated");
    out.push(blob.subarray(offset, offset + length));
    offset += length;
  }
  return out;
}

const CURVES = {
  "P-256": { name: "nistp256", bits: 256 },
  "P-384": { name: "nistp384", bits: 384 },
  "P-521": { name: "nistp521", bits: 521 },
} as const;

interface Encoded {
  type: string;
  bits: number;
  publicBlob: Buffer;
  privateFields: Buffer;
}

/** The OpenSSH public blob and private fields of a Node key pair. */
function encode(privateKey: KeyObject): Encoded {
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    const pub = b64url(jwk.x);
    const seed = b64url(jwk.d);
    const publicBlob = Buffer.concat([string("ssh-ed25519"), string(pub)]);
    return {
      type: "ssh-ed25519",
      bits: 256,
      publicBlob,
      privateFields: Buffer.concat([
        string("ssh-ed25519"),
        string(pub),
        string(Buffer.concat([seed, pub])),
      ]),
    };
  }
  if (jwk.kty === "EC") {
    const curve = CURVES[jwk.crv as keyof typeof CURVES];
    const type = `ecdsa-sha2-${curve.name}`;
    const point = Buffer.concat([Buffer.from([4]), b64url(jwk.x), b64url(jwk.y)]);
    return {
      type,
      bits: curve.bits,
      publicBlob: Buffer.concat([string(type), string(curve.name), string(point)]),
      privateFields: Buffer.concat([
        string(type),
        string(curve.name),
        string(point),
        mpint(b64url(jwk.d)),
      ]),
    };
  }
  const n = b64url(jwk.n);
  return {
    type: "ssh-rsa",
    bits: (privateKey.asymmetricKeyDetails?.modulusLength ?? n.length * 8),
    publicBlob: Buffer.concat([string("ssh-rsa"), mpint(b64url(jwk.e)), mpint(n)]),
    privateFields: Buffer.concat([
      string("ssh-rsa"),
      mpint(n),
      mpint(b64url(jwk.e)),
      mpint(b64url(jwk.d)),
      mpint(b64url(jwk.qi)),
      mpint(b64url(jwk.p)),
      mpint(b64url(jwk.q)),
    ]),
  };
}

/** An unencrypted `openssh-key-v1` private key, as `ssh-keygen` writes one. */
function opensshPrivate(encoded: Encoded, comment: string): string {
  const check = randomBytes(4);
  let section = Buffer.concat([check, check, encoded.privateFields, string(comment)]);
  const padding: number[] = [];
  for (let index = 1; (section.length + padding.length) % 8 !== 0; index++) padding.push(index);
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    string("none"),
    string("none"),
    string(""),
    u32(1),
    string(encoded.publicBlob),
    string(section),
  ]).toString("base64");
  const lines = body.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export const fingerprintOf = (blob: Buffer) =>
  `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

const PUBLIC_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

/** Parses and checks one public key line (type, blob and optional comment). */
export function parsePublicKey(line: string): {
  type: string;
  bits: number;
  blob: Buffer;
  comment: string;
} {
  const invalid = () =>
    new ApiError(400, "VALIDATION_FAILED", "Not an SSH public key", {
      details: [{ path: "publicKey", message: "Not an SSH public key" }],
    });
  const lines = line.trim().split(/\r?\n/);
  if (lines.length !== 1) throw invalid();
  const [type = "", data = "", ...rest] = lines[0]!.trim().split(/\s+/);
  if (!PUBLIC_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalid();
  const blob = Buffer.from(data, "base64");
  try {
    const [inner] = readStrings(blob, 1);
    if (inner?.toString() !== type) throw invalid();
    let bits = 256;
    if (type === "ssh-rsa") {
      const [, , n] = readStrings(blob, 3);
      const modulus = n!.subarray(n![0] === 0 ? 1 : 0);
      bits = modulus.length * 8;
      if (bits < 2048) throw invalid();
    } else if (type.startsWith("ecdsa-sha2-")) {
      const [, curve] = readStrings(blob, 3);
      bits = Number(curve?.toString().replace("nistp", "")) || 0;
    } else if (type === "ssh-ed25519") {
      const [, key] = readStrings(blob, 2);
      if (key?.length !== 32) throw invalid();
    } else readStrings(blob, 2);
    return { type, bits, blob, comment: rest.join(" ").slice(0, 200) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid();
  }
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  type: string;
  bits: number;
  comment: string;
  fingerprint: string;
  public_key: string;
  sealed_private: string | null;
  created_at: number;
  updated_at: number;
}

/** Where ssh-keygen lives, when it is installed (passphrase-protected exports need it). */
function sshKeygen(): string | null {
  for (const directory of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin"])
    if (existsSync(join(directory, "ssh-keygen"))) return join(directory, "ssh-keygen");
  return null;
}

export class AppSshKeys {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #now: () => number;
  /** A private directory for the moment ssh-keygen encrypts an export. */
  readonly #scratch: string;

  constructor(options: { db: Database; secrets: SecretBox; now: () => number; dir: string }) {
    this.#db = options.db;
    this.#secrets = options.secrets;
    this.#now = options.now;
    this.#scratch = options.dir;
  }

  #view(row: Row): SshKey {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      bits: row.bits,
      comment: row.comment,
      fingerprint: row.fingerprint,
      publicKey: row.public_key,
      hasPrivateKey: row.sealed_private !== null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #row(userId: string, id: string): Row {
    const row = this.#db.get<Row>(
      "SELECT * FROM desktop_app_ssh_keys WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!row) throw notFound("Key");
    return row;
  }

  /** Whether the key holds a private part (the desktop confirms deleting those). */
  hasPrivate(userId: string, id: string): boolean {
    return this.#row(userId, id).sealed_private !== null;
  }

  list(userId: string): SshKey[] {
    return this.#db
      .all<Row>("SELECT * FROM desktop_app_ssh_keys WHERE user_id = ? ORDER BY created_at, rowid", userId)
      .map((row) => this.#view(row));
  }

  #insert(
    userId: string,
    fields: {
      name: string;
      type: string;
      bits: number;
      comment: string;
      blob: Buffer;
      privateKey: string | null;
    },
  ): SshKey {
    const count = this.#db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM desktop_app_ssh_keys WHERE user_id = ?",
      userId,
    );
    if ((count?.count ?? 0) >= MAX_KEYS) throw new ApiError(409, "CONFLICT", "Too many keys");
    const id = randomUUID();
    const fingerprint = fingerprintOf(fields.blob);
    const publicKey = `${fields.type} ${fields.blob.toString("base64")}${fields.comment ? ` ${fields.comment}` : ""}`;
    const now = this.#now();
    try {
      this.#db.run(
        `INSERT INTO desktop_app_ssh_keys(id, user_id, name, type, bits, comment, fingerprint,
           public_key, sealed_private, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        fields.name,
        fields.type,
        fields.bits,
        fields.comment,
        fingerprint,
        publicKey,
        fields.privateKey
          ? this.#secrets.seal(fields.privateKey, privateContext(userId, id))
          : null,
        now,
        now,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new ApiError(409, "CONFLICT", "This key is already in the list");
      throw error;
    }
    return this.#view(this.#row(userId, id));
  }

  generate(userId: string, input: { name: string; type: SshKeyType; comment: string }): SshKey {
    const { privateKey } =
      input.type === "ed25519"
        ? generateKeyPairSync("ed25519")
        : input.type.startsWith("ecdsa-")
          ? generateKeyPairSync("ec", {
              namedCurve: `P-${input.type.slice("ecdsa-".length)}`,
            })
          : generateKeyPairSync("rsa", {
              modulusLength: Number(input.type.slice("rsa-".length)),
            });
    const encoded = encode(privateKey);
    return this.#insert(userId, {
      name: input.name,
      type: encoded.type,
      bits: encoded.bits,
      comment: input.comment,
      blob: encoded.publicBlob,
      privateKey: opensshPrivate(encoded, input.comment),
    });
  }

  import(userId: string, input: { name: string; publicKey: string }): SshKey {
    const parsed = parsePublicKey(input.publicKey);
    return this.#insert(userId, {
      name: input.name,
      type: parsed.type,
      bits: parsed.bits,
      comment: parsed.comment,
      blob: parsed.blob,
      privateKey: null,
    });
  }

  /** Renames a key; the comment changes in its public line (a private key keeps its own). */
  update(userId: string, input: { id: string; name: string; comment: string }): SshKey {
    const row = this.#row(userId, input.id);
    const [type = "", data = ""] = row.public_key.split(" ");
    this.#db.run(
      "UPDATE desktop_app_ssh_keys SET name = ?, comment = ?, public_key = ?, updated_at = ? WHERE id = ?",
      input.name,
      input.comment,
      `${type} ${data}${input.comment ? ` ${input.comment}` : ""}`,
      this.#now(),
      row.id,
    );
    return this.#view(this.#row(userId, row.id));
  }

  /**
   * The public line, or the private key (only after the person confirmed: `confirmed` comes from
   * the desktop), encrypted by ssh-keygen with the passphrase when one is given.
   */
  async export(
    userId: string,
    input: { id: string; private: boolean; passphrase: string | null },
    confirmed: boolean,
  ): Promise<{ text: string; fileName: string }> {
    const row = this.#row(userId, input.id);
    const base = row.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "key";
    if (!input.private) return { text: `${row.public_key}\n`, fileName: `${base}.pub` };
    if (!row.sealed_private) throw notFound("Private key");
    if (!confirmed)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Exporting a private key needs the person's confirmation",
        {
          details: { confirmation: "required" },
        },
      );
    const plain = this.#secrets.open(row.sealed_private, privateContext(userId, row.id));
    if (!input.passphrase) return { text: plain, fileName: base };
    return { text: await this.#encrypt(plain, input.passphrase), fileName: base };
  }

  /**
   * ssh-keygen re-encrypts a copy of the key with the passphrase (OpenSSH's bcrypt KDF and
   * AES-256). The passphrase reaches it through an askpass helper's environment, never the
   * command line, which other users could read.
   */
  async #encrypt(plain: string, passphrase: string): Promise<string> {
    const keygen = sshKeygen();
    if (!keygen)
      throw new ApiError(503, "HOST_CAPABILITY_UNAVAILABLE", "ssh-keygen is not installed", {
        details: { tool: "ssh-keygen" },
      });
    const dir = await mkdtemp(join(this.#scratch, "ssh-"));
    try {
      await chmod(dir, 0o700);
      const key = join(dir, "key");
      const askpass = join(dir, "askpass");
      await writeFile(key, plain, { mode: 0o600 });
      await writeFile(askpass, "#!/bin/sh\nprintf '%s\\n' \"$EVERYOS_SSH_PASSPHRASE\"\n", {
        mode: 0o700,
      });
      await run(keygen, ["-q", "-p", "-f", key], {
        timeout: 30_000,
        env: {
          PATH: "/usr/bin:/bin",
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: ":0",
          EVERYOS_SSH_PASSPHRASE: passphrase,
        },
      });
      const encrypted = await readFile(key, "utf8");
      if (encrypted === plain) throw new Error("ssh-keygen left the key unencrypted");
      return encrypted;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  delete(userId: string, id: string): void {
    this.#row(userId, id);
    this.#db.run("DELETE FROM desktop_app_ssh_keys WHERE id = ? AND user_id = ?", id, userId);
  }
}
