import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deriveKey } from "@everyos/security";

/** Fingerprint of a server secret (BackupManifest.keyId); never the secret itself. */
export function keyIdOf(masterKey: Buffer): string {
  return createHash("sha256")
    .update(deriveKey(masterKey, "otuken/backup-key-id/v1"))
    .digest("hex")
    .slice(0, 32);
}

export const keyFileText = (key: Buffer) => `${key.toString("base64url")}\n`;

export function parseKeyText(text: string): Buffer | null {
  const key = Buffer.from(text.trim(), "base64url");
  return key.length === 32 && /^[A-Za-z0-9_-]{43}$/.test(text.trim()) ? key : null;
}

/** Writes a key file privately and atomically. */
export function writeKeyFile(path: string, key: Buffer): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, keyFileText(key), { mode: 0o600, flag: "w" });
  renameSync(temporary, path);
}

/**
 * The server secrets this installation can use for restores (docs/backups.md): the current one,
 * the ones replaced by database restores and the ones that came inside encrypted backups. Kept as
 * `<dataDir>/keys/<keyId>.key`, protected like `secret.key` itself.
 */
export class Keyring {
  readonly dir: string;
  readonly current: Buffer;
  readonly currentId: string;

  constructor(dir: string, current: Buffer) {
    this.dir = dir;
    this.current = current;
    this.currentId = keyIdOf(current);
  }

  get(keyId: string): Buffer | null {
    if (keyId === this.currentId) return this.current;
    if (!/^[a-f0-9]{32}$/.test(keyId)) return null;
    try {
      const key = parseKeyText(readFileSync(join(this.dir, `${keyId}.key`), "utf8"));
      return key && keyIdOf(key) === keyId ? key : null;
    } catch {
      return null;
    }
  }

  has(keyId: string): boolean {
    return this.get(keyId) !== null;
  }

  /** Remembers a key (also the current one, which a restore is about to replace); returns its id. */
  add(key: Buffer): string {
    const keyId = keyIdOf(key);
    const path = join(this.dir, `${keyId}.key`);
    if (existsSync(path)) return keyId;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeKeyFile(path, key);
    return keyId;
  }

  ids(): string[] {
    try {
      return readdirSync(this.dir)
        .map((name) => /^([a-f0-9]{32})\.key$/.exec(name)?.[1])
        .filter((id): id is string => id !== undefined);
    } catch {
      return [];
    }
  }
}
