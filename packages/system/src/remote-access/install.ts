import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readFile, readdir, mkdir, open, rm, link, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteAccessProviderId } from "@everyos/shared";
import { assertPackageMutationSafe } from "../apt/safety.ts";
import type { AptManager } from "../apt/manager.ts";
import { findExecutable } from "../exec.ts";
import { parseOsRelease } from "../parsers.ts";
import { RemoteAccessError } from "./providers.ts";

const NETBIRD_KEY_SHA256 = "6bd434c07e7c3a71211de79ca287e93b45deadedc4b74f1a2e83e11abe6e0bf5";
const TAILSCALE_KEY_SHA256 = "3e03dacf222698c60b8e2f990b809ca1b3e104de127767864284e6c228f1fb39";
export function remoteAccessRepository(provider: RemoteAccessProviderId, osText: string) {
  const os = parseOsRelease(osText),
    id = os.ID,
    codename = os.VERSION_CODENAME;
  if (!["debian", "ubuntu"].includes(id ?? ""))
    throw new RemoteAccessError("REMOTE_INSTALL_UNSUPPORTED");
  if (provider === "netbird")
    return {
      keyUrl: "https://pkgs.netbird.io/debian/public.key",
      keyHash: NETBIRD_KEY_SHA256,
      keyName: "everyos-netbird.asc",
      host: "pkgs.netbird.io",
      repository: "https://pkgs.netbird.io/debian",
      suite: "stable",
      component: "main",
    };
  if (!codename || !/^[a-z][a-z0-9-]{1,32}$/.test(codename))
    throw new RemoteAccessError("REMOTE_INSTALL_UNSUPPORTED");
  return {
    keyUrl: `https://pkgs.tailscale.com/stable/${id}/${codename}.noarmor.gpg`,
    keyHash: TAILSCALE_KEY_SHA256,
    keyName: "everyos-tailscale.gpg",
    host: "pkgs.tailscale.com",
    repository: `https://pkgs.tailscale.com/stable/${id}`,
    suite: codename,
    component: "main",
  };
}
async function boundedKey(address: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(address, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok || !response.body) throw new RemoteAccessError("REMOTE_REPOSITORY_KEY");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      const chunk: unknown = value.value;
      if (!(chunk instanceof Uint8Array)) throw new RemoteAccessError("REMOTE_REPOSITORY_KEY");
      size += chunk.length;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new RemoteAccessError("REMOTE_REPOSITORY_KEY");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export interface RemoteRepositoryOptions {
  root?: string;
  checkSafe?: typeof assertPackageMutationSafe;
  fetchKey?: typeof boundedKey;
}
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function pinnedFile(path: string, digest: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 65536 ||
      info.nlink !== 1 ||
      info.uid !== process.geteuid?.() ||
      (info.mode & 0o7022) !== 0 ||
      sha256(await handle.readFile()) !== digest
    )
      throw new RemoteAccessError("REMOTE_REPOSITORY_CONFLICT");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function publicFile(handle: FileHandle): Promise<void> {
  try {
    if (((await handle.stat()).mode & 0o777) !== 0o644) await handle.chmod(0o644);
  } catch {
    throw new RemoteAccessError("REMOTE_REPOSITORY_PERMISSIONS");
  }
}
async function publicDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new RemoteAccessError("REMOTE_REPOSITORY_PERMISSIONS");
    if (!(await lstat(path)).isDirectory())
      throw new RemoteAccessError("REMOTE_REPOSITORY_CONFLICT");
    return; // Existing administrator directory permissions are never changed.
  }
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.chmod(0o755);
  } finally {
    await directory.close();
  }
}
async function repairOwnedRepository(
  source: string,
  key: string,
  sourceText: string,
  keyHash: string,
  signal: AbortSignal,
): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await pinnedFile(source, sha256(sourceText));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RemoteAccessError("REMOTE_REPOSITORY_CONFLICT");
  }
  try {
    const publicKey = await pinnedFile(key, keyHash);
    try {
      signal.throwIfAborted();
      // Only exact, owner-controlled EveryOS files qualify; never chmod an arbitrary keyring.
      await publicFile(publicKey);
      await publicFile(file);
    } finally {
      await publicKey.close();
    }
    return true;
  } catch (error) {
    if (error instanceof RemoteAccessError) throw error;
    throw new RemoteAccessError("REMOTE_REPOSITORY_CONFLICT");
  } finally {
    await file.close();
  }
}
async function writeExclusive(path: string, value: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(value);
      // The agent keeps UMask=0077. These two public APT files must be readable by _apt.
      await handle.chmod(0o644);
    } finally {
      await handle.close();
    }
    // Publish complete bytes without replacing an existing administrator file or symlink.
    await link(temporary, path);
  } finally {
    if (created) await rm(temporary, { force: true });
  }
}
/** Vendor URLs, paths and trust pins are fixed; never execute a downloaded installer script. */
export async function prepareRemoteRepository(
  provider: RemoteAccessProviderId,
  allowed: boolean,
  signal: AbortSignal,
  options: RemoteRepositoryOptions = {},
): Promise<void> {
  await (options.checkSafe ?? assertPackageMutationSafe)();
  signal.throwIfAborted();
  const root = options.root ?? "/",
    path = (value: string) => join(root, value);
  const repository = remoteAccessRepository(
    provider,
    await readFile(path("etc/os-release"), "utf8"),
  );
  const sourceDir = path("etc/apt/sources.list.d"),
    key = path(`usr/share/keyrings/${repository.keyName}`),
    source = join(sourceDir, `everyos-${provider}.sources`),
    files: string[] = [path("etc/apt/sources.list")];
  const text = `# Managed by EveryOS Remote Access\nTypes: deb\nURIs: ${repository.repository}\nSuites: ${repository.suite}\nComponents: ${repository.component}\nSigned-By: /usr/share/keyrings/${repository.keyName}\n`;
  if (await repairOwnedRepository(source, key, text, repository.keyHash, signal)) return;
  for (const name of await readdir(sourceDir).catch(() => [] as string[]))
    if (/\.(?:list|sources)$/.test(name)) files.push(join(sourceDir, name));
  for (const file of files) {
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size > 1024 * 1024) continue;
    const contents = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // Existing administrator-managed vendor repositories are kept byte-for-byte.
    if (contents.includes(repository.repository)) return;
  }
  if (!allowed) throw new RemoteAccessError("REMOTE_REPOSITORY_REQUIRED");
  const bytes = await (options.fetchKey ?? boundedKey)(repository.keyUrl, signal);
  if (sha256(bytes) !== repository.keyHash) throw new RemoteAccessError("REMOTE_REPOSITORY_KEY");
  signal.throwIfAborted();
  await publicDirectory(path("usr/share/keyrings"));
  await publicDirectory(sourceDir);
  let createdKey = false;
  try {
    try {
      await writeExclusive(key, bytes);
      createdKey = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await pinnedFile(key, repository.keyHash);
      try {
        await publicFile(existing);
      } finally {
        await existing.close();
      }
    }
    await writeExclusive(source, text);
  } catch (error) {
    if (createdKey) await rm(key, { force: true });
    if (error instanceof RemoteAccessError) throw error;
    throw new RemoteAccessError("REMOTE_REPOSITORY_CONFLICT");
  }
}
export async function* installRemoteAccessProvider(
  apt: AptManager,
  provider: RemoteAccessProviderId,
  configureRepository: boolean,
  signal: AbortSignal,
  options: RemoteRepositoryOptions & { find?: typeof findExecutable } = {},
) {
  try {
    const find = options.find ?? findExecutable;
    yield { type: "stage" as const, stage: "preparing" as const };
    if (apt.source !== "host" || !apt.installRemoteAccess)
      throw new RemoteAccessError("REMOTE_INSTALL_UNSUPPORTED");
    if (await find(provider, { refresh: true })) {
      yield { type: "done" as const, ok: true, error: null };
      return;
    }
    await prepareRemoteRepository(provider, configureRepository, signal, options);
    yield { type: "stage" as const, stage: "refreshing" as const };
    const refreshed = await apt.refresh(signal);
    if (!refreshed.ok)
      throw new RemoteAccessError(
        refreshed.busy ? "REMOTE_PACKAGE_BUSY" : remoteAccessRefreshFailure(refreshed.output),
      );
    yield { type: "stage" as const, stage: "installing" as const };
    const result = await apt.installRemoteAccess(provider, signal);
    if (!result.ok)
      throw new RemoteAccessError(result.busy ? "REMOTE_PACKAGE_BUSY" : "REMOTE_INSTALL_FAILED");
    yield { type: "stage" as const, stage: "checking" as const };
    if (!(await find(provider, { refresh: true })))
      throw new RemoteAccessError("REMOTE_INSTALL_VERIFY_FAILED");
    yield { type: "done" as const, ok: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safe = /^(?:REMOTE_[A-Z_]+|PACKAGE_ENVIRONMENT_UNSAFE|PACKAGE_STATE_UNSAFE)$/.test(
      message,
    )
      ? message
      : "REMOTE_INSTALL_FAILED";
    yield { type: "done" as const, ok: false, error: safe };
  }
}

/** Classify bounded APT output without exposing private repository/proxy URLs or credentials. */
export function remoteAccessRefreshFailure(output: string): string {
  if (/No space left on device|not enough free space/i.test(output)) return "REMOTE_REFRESH_SPACE";
  if (/Permission denied|Read-only file system|keyring.*not readable/i.test(output))
    return "REMOTE_REFRESH_PERMISSIONS";
  if (
    /NO_PUBKEY|EXPKEYSIG|BADSIG|GPG error|not signed|signatures? (?:couldn't|could not) be verified|Hash Sum mismatch/i.test(
      output,
    )
  )
    return "REMOTE_REFRESH_SIGNATURE";
  if (
    /Temporary failure resolving|Could not resolve|Could not connect|Network is unreachable|Connection (?:failed|timed out)|Could not handshake|Certificate verification failed/i.test(
      output,
    )
  )
    return "REMOTE_REFRESH_NETWORK";
  if (
    /does not have a Release file|no longer has a Release file|Malformed (?:entry|stanza)|Conflicting values set for option Signed-By|404\s+Not Found|Release file.*(?:expired|not valid yet)/i.test(
      output,
    )
  )
    return "REMOTE_REFRESH_REPOSITORY";
  return "REMOTE_REFRESH_FAILED";
}
