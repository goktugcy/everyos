import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  statfs,
  symlink,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import {
  OperationError,
  type Actor,
  type OperationContext,
  type OperationParams,
  type OperationResult,
} from "@otuken/agent-protocol";
import { readTar, safeRelativePath, sinkTo, TarWriter } from "@otuken/system/archive";
import type { Logger } from "@otuken/logger";
import type { ManagedAppManager } from "./managed-apps.ts";

/** Decompressed content of a file (read errors end the stream instead of hanging it). */
async function* gunzipFile(path: string): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  const source = createReadStream(path);
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  for await (const chunk of gunzip) yield chunk as Buffer;
}

/** Data of one app: entries and size limits for a single archive. */
const MAX_ENTRIES = 500_000;
const MAX_BYTES = 512 * 1024 ** 3;
/** Free space left on the agent's disk after a restore. */
const RESTORE_RESERVE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
/** Transfers nobody continues are released (and the app unlocked) after this long. */
const IDLE_MS = 10 * 60_000;
const MAX_TRANSFERS = 2;

interface Entry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  linkname: string;
}

interface Export {
  id: string;
  userId: string;
  release: () => void;
  controller: AbortController;
  chunks: AsyncGenerator<Buffer>;
  hash: Hash;
  size: number;
  reading: boolean;
  timer: NodeJS.Timeout;
}

interface Import {
  id: string;
  userId: string;
  path: string;
  handle: FileHandle;
  size: number;
  received: number;
  hash: Hash;
  timer: NodeJS.Timeout;
  committing: boolean;
}

const isRoot = () => process.getuid?.() === 0;
const userOf = (actor: Actor) =>
  actor.kind === "user" ? actor.userId : `system:${actor.component}`;

/** Lists the data directory: directories, regular files and symlinks; other types are skipped. */
async function walk(
  dataDir: string,
  signal: AbortSignal,
): Promise<{ entries: Entry[]; bytes: number; skipped: number }> {
  const root = await lstat(dataDir);
  if (!root.isDirectory())
    throw new OperationError("policy_denied", "Application data is not a directory");
  const entries: Entry[] = [];
  let bytes = 0;
  let skipped = 0;
  const visit = async (path: string, name: string): Promise<void> => {
    signal.throwIfAborted();
    const info = await lstat(path);
    const base = {
      path,
      name,
      mode: info.mode & 0o7777,
      uid: info.uid,
      gid: info.gid,
      mtime: info.mtimeMs,
      size: 0,
      linkname: "",
    };
    // Stay on the data directory's filesystem (like `tar --one-file-system`).
    if (info.dev !== root.dev) {
      skipped++;
      return;
    }
    if (info.isDirectory()) {
      entries.push({ ...base, type: "directory" });
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), `${name}/${child}`);
    } else if (info.isFile()) {
      entries.push({ ...base, type: "file", size: info.size });
      bytes += info.size;
    } else if (info.isSymbolicLink()) {
      entries.push({ ...base, type: "symlink", linkname: await readlink(path) });
    } else skipped++;
    if (entries.length > MAX_ENTRIES || bytes > MAX_BYTES)
      throw new OperationError("invalid_params", "Application data exceeds backup limits");
  };
  await visit(dataDir, "data");
  return { entries, bytes, skipped };
}

/** The tar.gz archive of `entries`, in chunks of CHUNK_BYTES (produced only as they are read). */
async function* archiveChunks(entries: Entry[], signal: AbortSignal): AsyncGenerator<Buffer> {
  const gzip = createGzip({ level: 4 });
  const writer = new TarWriter(sinkTo(gzip));
  const producing = (async () => {
    for (const entry of entries) {
      signal.throwIfAborted();
      const header = {
        name: entry.name,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtime: entry.mtime,
      };
      if (entry.type === "directory") await writer.directory(header);
      else if (entry.type === "symlink")
        await writer.symlink({ ...header, linkname: entry.linkname });
      else {
        const handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await writer.file(
            { ...header, size: entry.size },
            handle.createReadStream({ autoClose: false }),
          );
        } finally {
          await handle.close();
        }
      }
    }
    await writer.end();
    gzip.end();
  })().catch((error: unknown) => {
    gzip.destroy(error as Error);
  });
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  try {
    for await (const raw of gzip) {
      const chunk = raw as Buffer;
      for (let offset = 0; offset < chunk.length;) {
        const take = Math.min(CHUNK_BYTES - pendingBytes, chunk.length - offset);
        pending.push(chunk.subarray(offset, offset + take));
        pendingBytes += take;
        offset += take;
        if (pendingBytes === CHUNK_BYTES) {
          yield Buffer.concat(pending);
          pending = [];
          pendingBytes = 0;
        }
      }
    }
    if (pendingBytes > 0) yield Buffer.concat(pending);
  } finally {
    gzip.destroy();
    await producing;
  }
}

/**
 * App data backups for the agent (docs/backups.md). The app must be stopped:
 * a running database is never copied file by file. Archives contain only
 * directories, regular files and symbolic links; restores extract into a fresh
 * directory without following links and then swap it in.
 */
export class AppDataBackups {
  readonly #apps: ManagedAppManager;
  readonly #logger: Logger;
  readonly #imports = new Map<string, Import>();
  readonly #exports = new Map<string, Export>();

  constructor(options: { apps: ManagedAppManager; logger: Logger }) {
    this.#apps = options.apps;
    this.#logger = options.logger.child({ component: "app-data-backup" });
  }

  async beginExport(
    { id }: OperationParams<"backups.appdata.export.begin">,
    { actor }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.export.begin">> {
    if (this.#exports.size >= MAX_TRANSFERS)
      throw new OperationError("busy", "Too many backups in progress");
    const app = await this.#apps.ownedApp(id);
    const release = this.#apps.lockProject(app.project);
    const controller = new AbortController();
    try {
      if (await this.#apps.projectRunning(app.project))
        throw new OperationError("conflict", "APP_RUNNING: stop the application first");
      const listing = await walk(app.dataDir, controller.signal);
      const token = randomBytes(16).toString("hex");
      this.#exports.set(token, {
        id,
        userId: userOf(actor),
        release,
        controller,
        chunks: archiveChunks(listing.entries, controller.signal),
        hash: createHash("sha256"),
        size: 0,
        reading: false,
        timer: this.#expiry(() => this.#endExport(token)),
      });
      return {
        token,
        entries: listing.entries.length,
        bytes: listing.bytes,
        skipped: listing.skipped,
      };
    } catch (error) {
      release();
      if (error instanceof OperationError) throw error;
      this.#logger.warn("App data export failed", { appId: id, error });
      throw new OperationError("failed", "Could not read the application data");
    }
  }

  async readExport(
    { token }: OperationParams<"backups.appdata.export.read">,
    { actor }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.export.read">> {
    const entry = this.#exports.get(token);
    if (!entry || entry.userId !== userOf(actor))
      throw new OperationError("not_found", "No such backup transfer");
    if (entry.reading) throw new OperationError("busy", "A read is already in progress");
    entry.reading = true;
    entry.timer.refresh();
    try {
      const next = await entry.chunks.next();
      if (next.done) {
        const result = { done: true as const, size: entry.size, sha256: entry.hash.digest("hex") };
        await this.#endExport(token);
        return result;
      }
      entry.hash.update(next.value);
      entry.size += next.value.length;
      return { done: false, data: next.value.toString("base64") };
    } catch (error) {
      await this.#endExport(token);
      if (error instanceof OperationError) throw error;
      this.#logger.warn("App data export failed", { appId: entry.id, error });
      throw new OperationError("failed", "Could not archive the application data");
    } finally {
      entry.reading = false;
    }
  }

  async abortExport(
    { token }: OperationParams<"backups.appdata.export.abort">,
    { actor }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.export.abort">> {
    const entry = this.#exports.get(token);
    if (!entry || entry.userId !== userOf(actor)) return { aborted: false };
    await this.#endExport(token);
    return { aborted: true };
  }

  async #endExport(token: string): Promise<void> {
    const entry = this.#exports.get(token);
    if (!entry) return;
    this.#exports.delete(token);
    clearTimeout(entry.timer);
    entry.controller.abort();
    await entry.chunks.return(undefined).catch(() => undefined);
    entry.release();
  }

  async begin(
    { id, size }: OperationParams<"backups.appdata.import.begin">,
    { actor }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.import.begin">> {
    await this.#apps.ownedApp(id);
    if ([...this.#imports.values()].some((entry) => entry.id === id))
      throw new OperationError("busy", "A restore of this application is in progress");
    if (this.#imports.size >= MAX_TRANSFERS)
      throw new OperationError("busy", "Too many restores in progress");
    const token = randomBytes(16).toString("hex");
    const path = join(this.#apps.root, `.import-${token}.tar.gz`);
    const handle = await open(path, "wx", 0o600);
    this.#imports.set(token, {
      id,
      userId: userOf(actor),
      path,
      handle,
      size,
      received: 0,
      hash: createHash("sha256"),
      timer: this.#expiry(() => this.#discard(token)),
      committing: false,
    });
    return { token };
  }

  async chunk(
    { token, offset, data }: OperationParams<"backups.appdata.import.chunk">,
    { actor }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.import.chunk">> {
    const entry = this.#import(token, actor);
    if (entry.committing || offset !== entry.received)
      throw new OperationError("invalid_params", "Unexpected chunk offset");
    const bytes = Buffer.from(data, "base64");
    if (entry.received + bytes.length > entry.size)
      throw new OperationError("invalid_params", "More data than announced");
    await entry.handle.write(bytes, 0, bytes.length, offset);
    entry.received += bytes.length;
    entry.hash.update(bytes);
    entry.timer.refresh();
    return { received: entry.received };
  }

  async abort(
    { token }: OperationParams<"backups.appdata.import.abort">,
    { actor }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.import.abort">> {
    const entry = this.#imports.get(token);
    if (!entry || entry.userId !== userOf(actor) || entry.committing) return { aborted: false };
    await this.#discard(token);
    return { aborted: true };
  }

  async commit(
    { token, sha256 }: OperationParams<"backups.appdata.import.commit">,
    { actor, signal }: OperationContext,
  ): Promise<OperationResult<"backups.appdata.import.commit">> {
    const entry = this.#import(token, actor);
    if (entry.committing) throw new OperationError("busy", "Restore already committing");
    entry.committing = true;
    clearTimeout(entry.timer);
    try {
      if (entry.received !== entry.size || entry.hash.digest("hex") !== sha256)
        throw new OperationError("invalid_params", "Archive checksum mismatch");
      await entry.handle.close();
      const app = await this.#apps.ownedApp(entry.id);
      const release = this.#apps.lockProject(app.project);
      try {
        if (await this.#apps.projectRunning(app.project))
          throw new OperationError("conflict", "APP_RUNNING: stop the application first");
        return await this.#restore(entry.path, app.appDir, app.dataDir, token, signal);
      } finally {
        release();
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      this.#logger.warn("App data restore failed", { appId: entry.id, error });
      throw new OperationError("failed", "Could not restore the application data");
    } finally {
      await this.#discard(token);
    }
  }

  /** Releases every pending transfer (agent shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([
      ...[...this.#imports.keys()].map((token) => this.#discard(token)),
      ...[...this.#exports.keys()].map((token) => this.#endExport(token)),
    ]);
  }

  #import(token: string, actor: Actor): Import {
    const entry = this.#imports.get(token);
    if (!entry || entry.userId !== userOf(actor))
      throw new OperationError("not_found", "No such restore upload");
    return entry;
  }

  #expiry(end: () => Promise<void>): NodeJS.Timeout {
    const timer = setTimeout(() => void end(), IDLE_MS);
    timer.unref();
    return timer;
  }

  async #discard(token: string): Promise<void> {
    const entry = this.#imports.get(token);
    if (!entry) return;
    this.#imports.delete(token);
    clearTimeout(entry.timer);
    await entry.handle.close().catch(() => undefined);
    await rm(entry.path, { force: true });
  }

  async #restore(
    archive: string,
    appDir: string,
    dataDir: string,
    token: string,
    signal: AbortSignal,
  ): Promise<{ entries: number; bytes: number }> {
    const entries = () =>
      readTar(gunzipFile(archive), { maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES });
    // Pass 1: validate every member before anything is written.
    const directories = new Set<string>();
    const seen = new Set<string>();
    let count = 0;
    let bytes = 0;
    for await (const entry of entries()) {
      signal.throwIfAborted();
      const name = safeRelativePath(entry.name);
      if (!name || (name !== "data" && !name.startsWith("data/")) || seen.has(name))
        throw new OperationError("invalid_params", "Archive contains an unsafe path");
      if (count === 0 && (name !== "data" || entry.type !== "directory"))
        throw new OperationError(
          "invalid_params",
          "Archive does not start with the data directory",
        );
      const parent = name.slice(0, name.lastIndexOf("/"));
      if (name !== "data" && !directories.has(parent))
        throw new OperationError("invalid_params", "Archive lists a path before its directory");
      if (entry.type === "directory") directories.add(name);
      else if (entry.type === "file") bytes += entry.size;
      else if (entry.type !== "symlink" || !entry.linkname)
        throw new OperationError("policy_denied", "Archive contains a link or special file");
      seen.add(name);
      count++;
    }
    if (count === 0) throw new OperationError("invalid_params", "Archive is empty");
    const free = await statfs(appDir);
    if (free.bavail * free.bsize < bytes + count * 4096 + RESTORE_RESERVE_BYTES)
      throw new OperationError("conflict", "INSUFFICIENT_SPACE: not enough free space to restore");

    // Pass 2: extract into a fresh private directory, never following links.
    const staging = join(appDir, `.restore-${token}`);
    await mkdir(staging, { mode: 0o700 });
    const owner = isRoot();
    const deferred: Array<{ path: string; mode: number; uid: number; gid: number; mtime: number }> =
      [];
    try {
      for await (const entry of entries()) {
        signal.throwIfAborted();
        const target = join(staging, entry.name);
        const mode = entry.mode & 0o1777;
        if (entry.type === "directory") {
          await mkdir(target, { mode: 0o700 });
          deferred.push({ path: target, mode, uid: entry.uid, gid: entry.gid, mtime: entry.mtime });
        } else if (entry.type === "symlink") {
          await symlink(entry.linkname!, target);
          if (owner) await lchown(target, entry.uid, entry.gid);
          const time = new Date(entry.mtime);
          await lutimes(target, time, time).catch(() => undefined);
        } else {
          const handle = await open(
            target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            let position = 0;
            for await (const chunk of entry.content) {
              await handle.write(chunk, 0, chunk.length, position);
              position += chunk.length;
            }
            if (owner) await handle.chown(entry.uid, entry.gid);
            await handle.chmod(mode);
            const time = new Date(entry.mtime);
            await handle.utimes(time, time);
          } finally {
            await handle.close();
          }
        }
      }
      // Directory permissions last (deepest first), so restrictive modes do not block writes.
      for (const directory of deferred.reverse()) {
        if (owner) await chown(directory.path, directory.uid, directory.gid);
        await chmod(directory.path, directory.mode);
        const time = new Date(directory.mtime);
        await utimes(directory.path, time, time);
      }
      const previous = join(appDir, `.data-replaced-${token}`);
      const hadData = await lstat(dataDir)
        .then(() => true)
        .catch(() => false);
      if (hadData) await rename(dataDir, previous);
      try {
        await rename(join(staging, "data"), dataDir);
      } catch (error) {
        if (hadData) await rename(previous, dataDir);
        throw error;
      }
      await rm(previous, { recursive: true, force: true }).catch((error: unknown) => {
        this.#logger.warn("Could not remove the replaced application data", { previous, error });
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { entries: count, bytes };
  }
}
