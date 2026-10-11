import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class KeyFileError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message}: ${path}`);
    this.name = "KeyFileError";
    this.path = path;
  }
}

export interface KeyFileOptions {
  /** Create the key with fresh random bytes if the file does not exist. */
  create: boolean;
  /**
   * Refuse to use keys that are readable or writable by "other" users
   * (and group-writable). Enabled in production; can be relaxed for tests.
   */
  enforcePermissions: boolean;
  /** Mode used when creating a new key file. */
  mode?: number;
}

const KEY_BYTES = 32;

function parseKey(contents: string, path: string): Buffer {
  const key = Buffer.from(contents.trim(), "base64url");
  if (key.length !== KEY_BYTES) {
    throw new KeyFileError(`Key file must contain ${KEY_BYTES} base64url-encoded bytes`, path);
  }
  return key;
}

function assertPermissions(path: string): void {
  if (process.platform === "win32") return;
  const { mode } = statSync(path);
  // Group-read is allowed (root:everyos 0640 for the agent key); group-write and
  // any access for "other" is not.
  if ((mode & 0o027) !== 0) {
    throw new KeyFileError(
      `Key file permissions are too open (${(mode & 0o777).toString(8)}); expected 0600 or 0640`,
      path,
    );
  }
}

/**
 * Loads a 256-bit key from a file containing its base64url encoding, creating
 * it atomically (exclusive create) when allowed. The key never leaves the
 * process except through the derived keys it is used to compute.
 */
export function loadKeyFile(path: string, options: KeyFileOptions): Buffer {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new KeyFileError(`Key file is not readable: ${(error as Error).message}`, path);
    }
    if (!options.create) {
      throw new KeyFileError("Key file does not exist", path);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(path, `${key.toString("base64url")}\n`, {
        flag: "wx",
        mode: options.mode ?? 0o600,
      });
      return key;
    } catch (writeError) {
      // Another process created it first; fall through and read theirs.
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new KeyFileError(
          `Key file could not be created: ${(writeError as Error).message}`,
          path,
        );
      }
      contents = readFileSync(path, "utf8");
    }
  }
  if (options.enforcePermissions) assertPermissions(path);
  return parseKey(contents, path);
}
