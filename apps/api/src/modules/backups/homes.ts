import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { BackupHomeContent } from "@everyos/shared";
import { decodeMountField } from "@everyos/system";
import {
  readTar,
  safeRelativePath,
  sinkTo,
  TarWriter,
  type TarWriteHeader,
} from "@everyos/system/archive";
import { invalidBackup, SpaceGuard } from "./backup-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { maxEntries: 1_000_000, maxBytes: 1024 ** 4 };

/** A home restore must never remove host mounts, including bind mounts on the same device. */
export async function assertHomesUnmounted(
  root: string,
  users: readonly string[],
  mountinfo?: string,
): Promise<void> {
  const base = await realpath(root);
  const mounts =
    mountinfo ??
    (process.platform === "linux" ? await readFile("/proc/self/mountinfo", "utf8") : "");
  const points = mounts.split("\n").map((line) => decodeMountField(line.split(" ")[4] ?? ""));
  for (const id of users) {
    const home = join(base, id);
    if (points.some((point) => point === home || point.startsWith(home + sep)))
      throw invalidBackup("home-mount");
  }
}

/** Old copies are private staging data; make directories removable without following links. */
async function removeStage(stage: string): Promise<void> {
  if (
    !(await lstat(stage).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }))
  )
    return;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory()) return;
    await chmod(path, info.mode | 0o700);
    for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(stage);
  await rm(stage, { recursive: true, force: true });
}
type SourceEntry = { path: string; header: TarWriteHeader; inode: number; modifiedAt: number };

/** Only EveryOS account homes are captured; host OS homes and escaping link targets are never read. */
export async function archiveHomes(options: {
  root: string | null;
  users: readonly { id: string; username: string }[];
  target: string;
  guard: SpaceGuard;
  signal: AbortSignal;
  progress: (bytes: number) => void;
}): Promise<BackupHomeContent[]> {
  const { root, target, guard, signal } = options;
  if (!root) return [];
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return [];
  if (!rootInfo.isDirectory()) throw invalidBackup("homes-directory");
  const base = await realpath(root);
  const entries: SourceEntry[] = [];
  const targetPath = join(await realpath(dirname(target)), basename(target));
  const homes: BackupHomeContent[] = [];
  let totalBytes = 0;
  for (const user of options.users) {
    if (!UUID.test(user.id)) throw invalidBackup("home-id");
    const homePath = join(base, user.id);
    const info = await lstat(homePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || (await realpath(homePath)) !== homePath)
      throw invalidBackup("home-directory");
    if (targetPath.startsWith(homePath + sep)) throw invalidBackup("home-backup-location");
    const home: BackupHomeContent = {
      userId: user.id,
      username: user.username,
      dataBytes: 0,
      dataEntries: 0,
      skipped: 0,
    };
    const visit = async (path: string, name: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 128) throw invalidBackup("home-depth");
      const stats = await lstat(path);
      if (stats.dev !== info.dev) {
        home.skipped++;
        return;
      }
      const header = { name, mode: stats.mode & 0o777, mtime: stats.mtimeMs };
      let entry: TarWriteHeader;
      if (stats.isDirectory()) {
        if ((await realpath(path)) !== path) throw invalidBackup("home-changed");
        entry = { ...header, type: "directory" };
      } else if (stats.isFile()) {
        entry = { ...header, type: "file", size: stats.size };
        home.dataBytes += stats.size;
        totalBytes += stats.size;
      } else if (stats.isSymbolicLink()) {
        entry = { ...header, type: "symlink", linkname: await readlink(path) };
      } else {
        home.skipped++;
        return;
      }
      entries.push({ path, header: entry, inode: stats.ino, modifiedAt: stats.mtimeMs });
      home.dataEntries++;
      if (entries.length >= LIMITS.maxEntries || totalBytes > LIMITS.maxBytes)
        throw invalidBackup("homes-limit");
      if (stats.isDirectory())
        for (const child of (await readdir(path)).sort())
          await visit(join(path, child), `${name}/${child}`, depth + 1);
    };
    await visit(homePath, `homes/${user.id}`, 0);
    homes.push(home);
  }
  if (!homes.length) return [];
  await guard.require(totalBytes + entries.length * 2048);
  const gzip = createGzip({ level: 4 });
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  const writing = pipeline(gzip, output);
  const writer = new TarWriter(async (chunk) => {
    signal.throwIfAborted();
    await sinkTo(gzip)(chunk);
    options.progress(chunk.length);
    await guard.wrote(chunk.length);
  });
  const producing = (async () => {
    await writer.directory({ name: "homes", mode: 0o700, mtime: Date.now() });
    for (const entry of entries) {
      signal.throwIfAborted();
      if ((await realpath(dirname(entry.path))) !== dirname(entry.path))
        throw invalidBackup("home-changed");
      const header = entry.header;
      if (header.type === "directory") await writer.directory(header);
      else if (header.type === "symlink") await writer.symlink(header);
      else {
        const handle = await open(
          entry.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await handle.stat();
          if (
            !before.isFile() ||
            before.ino !== entry.inode ||
            before.size !== header.size ||
            before.mtimeMs !== entry.modifiedAt
          )
            throw invalidBackup("home-changed");
          await writer.file(header, handle.createReadStream({ autoClose: false }));
          const after = await handle.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            throw invalidBackup("home-changed");
        } finally {
          await handle.close();
        }
      }
    }
    await writer.end();
    gzip.end();
  })().catch((error: unknown) => {
    gzip.destroy(error as Error);
    throw error;
  });
  const results = await Promise.allSettled([producing, writing]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return homes;
}

async function* homeEntries(archive: string) {
  const input = createReadStream(archive);
  const gzip = createGunzip();
  input.on("error", (error) => gzip.destroy(error));
  input.pipe(gzip);
  try {
    yield* readTar(gzip, LIMITS);
  } finally {
    input.destroy();
    gzip.destroy();
  }
}

async function* checkedHomeEntries(
  archive: string,
  homes: readonly BackupHomeContent[],
  signal?: AbortSignal,
) {
  const expected = new Map(homes.map((home) => [home.userId, home]));
  const seen = new Set<string>();
  const directories = new Set<string>();
  const totals = new Map<string, { entries: number; bytes: number }>();
  for await (const entry of homeEntries(archive)) {
    signal?.throwIfAborted();
    const name = safeRelativePath(entry.name);
    const [top, userId] = name?.split("/") ?? [];
    if (
      !name ||
      name.length > 4096 ||
      name.split("/").length > 130 ||
      name.split("/").some((part) => Buffer.byteLength(part) > 255) ||
      top !== "homes" ||
      seen.has(name) ||
      (seen.size === 0 && (name !== "homes" || entry.type !== "directory"))
    )
      throw invalidBackup("home-path");
    if (name !== "homes") {
      if (
        !userId ||
        !expected.has(userId) ||
        !directories.has(name.slice(0, name.lastIndexOf("/")))
      )
        throw invalidBackup("home-parent");
      const total = totals.get(userId) ?? { entries: 0, bytes: 0 };
      total.entries++;
      if (entry.type === "file") total.bytes += entry.size;
      totals.set(userId, total);
    }
    if (entry.type === "directory") directories.add(name);
    else if (entry.type !== "file" && (entry.type !== "symlink" || !entry.linkname))
      throw invalidBackup("home-type");
    seen.add(name);
    yield { ...entry, name };
  }
  if (!seen.has("homes")) throw invalidBackup("homes-empty");
  for (const [id, home] of expected) {
    const total = totals.get(id);
    if (
      !directories.has(`homes/${id}`) ||
      total?.bytes !== home.dataBytes ||
      total.entries !== home.dataEntries
    )
      throw invalidBackup("home-manifest");
  }
}

/** Validate before writing; extraction repeats the same checks if an archive changes meanwhile. */
export async function validateHomes(
  archive: string,
  homes: readonly BackupHomeContent[],
  signal?: AbortSignal,
): Promise<void> {
  for await (const entry of checkedHomeEntries(archive, homes, signal)) {
    for await (const _chunk of entry.content) signal?.throwIfAborted();
  }
}

/** Replace only homes belonging to existing account ids; stage privately and roll back failed swaps. */
export async function restoreHomes(options: {
  archive: string;
  root: string;
  homes: readonly BackupHomeContent[];
  users: readonly string[];
  reserveBytes: number;
  signal: AbortSignal;
}): Promise<void> {
  const { archive, homes, users, signal } = options;
  await validateHomes(archive, homes, signal);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  if (!(await lstat(options.root)).isDirectory()) throw invalidBackup("homes-directory");
  const root = await realpath(options.root);
  await assertHomesUnmounted(root, users);
  const guard = new SpaceGuard(root, options.reserveBytes);
  await guard.require(
    homes
      .filter((home) => users.includes(home.userId))
      .reduce((sum, home) => sum + home.dataBytes + home.dataEntries * 4096, 0),
  );
  const stage = join(root, `.restore-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  const directories: Array<{ path: string; mode: number; mtime: number }> = [];
  const replaced: Array<{ id: string; previous: boolean }> = [];
  let complete = false;
  try {
    for await (const entry of checkedHomeEntries(archive, homes, signal)) {
      signal.throwIfAborted();
      const [, userId] = entry.name.split("/");
      if (userId && !users.includes(userId)) continue;
      const target = join(stage, entry.name);
      if (entry.type === "directory") {
        await mkdir(target, { mode: 0o700 });
        directories.push({ path: target, mode: entry.mode & 0o777, mtime: entry.mtime });
      } else if (entry.type === "symlink") await symlink(entry.linkname!, target);
      else {
        const handle = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          entry.mode & 0o777,
        );
        try {
          for await (const chunk of entry.content) {
            await handle.writeFile(chunk);
            await guard.wrote(chunk.length);
            signal.throwIfAborted();
          }
        } finally {
          await handle.close();
        }
        await utimes(target, entry.mtime / 1000, entry.mtime / 1000);
      }
    }
    for (const directory of directories.reverse()) {
      await chmod(
        directory.path,
        directory.path.split(sep).at(-2) === "homes" ? 0o700 : directory.mode,
      );
      await utimes(directory.path, directory.mtime / 1000, directory.mtime / 1000);
    }
    for (const id of users) {
      signal.throwIfAborted();
      if (!UUID.test(id) || !homes.some((home) => home.userId === id))
        throw invalidBackup("home-id");
      const current = await lstat(join(root, id)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (current && !current.isDirectory()) throw invalidBackup("home-directory");
      if (current) await rename(join(root, id), join(stage, `old-${id}`));
      replaced.push({ id, previous: current !== null });
      await rename(join(stage, "homes", id), join(root, id));
    }
    signal.throwIfAborted();
    complete = true;
  } finally {
    if (!complete)
      for (const item of replaced.reverse()) {
        await removeStage(join(root, item.id));
        if (item.previous) await rename(join(stage, `old-${item.id}`), join(root, item.id));
      }
    await removeStage(stage);
  }
}
