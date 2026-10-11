import { randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { openDatabase, type Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { LocalizedText } from "@everyos/shared";
import { readTar, safeRelativePath, TarWriter, sinkTo } from "@everyos/system/archive";

/*
 * Database snapshots and the EveryOS-side parts of a restore (docs/backups.md).
 * Snapshots use SQLite's online backup API, never a file copy of a live
 * database, and leave out sessions so a backup never carries a usable login.
 */

const WALLPAPER_FILE = /^wallpapers\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,64}\.(?:jpg|png|webp)$/;

const tableExists = (db: Database, name: string) =>
  db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?",
    name,
  )!.n > 0;

export function schemaVersionOf(db: Database): number {
  return db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations")?.v ?? 0;
}

async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all(
    ["", "-wal", "-shm", "-journal"].map((suffix) => rm(`${path}${suffix}`, { force: true })),
  );
}

/** Writes a consistent, session-free, compacted snapshot as gzip; returns its schema version. */
export async function snapshotDatabase(
  db: Database,
  target: string,
  workDir: string,
): Promise<number> {
  const temp = join(workDir, `snapshot-${randomBytes(4).toString("hex")}.db`);
  try {
    await db.backupTo(temp);
    const copy = openDatabase(temp);
    let version: number;
    try {
      copy.exec("DELETE FROM sessions");
      version = schemaVersionOf(copy);
      copy.exec("PRAGMA journal_mode = DELETE");
      // Rebuilds the file so deleted rows do not linger in free pages.
      copy.exec("VACUUM");
    } finally {
      copy.close();
    }
    await pipeline(
      createReadStream(temp),
      createGzip({ level: 6 }),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    return version;
  } finally {
    await removeDatabaseFiles(temp);
  }
}

export async function gunzipFile(source: string, target: string): Promise<void> {
  await pipeline(
    createReadStream(source),
    createGunzip(),
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
  );
}

/** Runs `fn` on a temporary, decompressed copy of a database snapshot. */
export async function withSnapshot<T>(
  gz: string,
  workDir: string,
  fn: (path: string) => Promise<T> | T,
): Promise<T> {
  const temp = join(workDir, `.work-${randomBytes(6).toString("hex")}.db`);
  try {
    await gunzipFile(gz, temp);
    return await fn(temp);
  } finally {
    await removeDatabaseFiles(temp);
  }
}

export interface SnapshotSummary {
  ok: boolean;
  schemaVersion: number;
  users: { id: string; username: string; role: string }[];
  apps: { id: string; name: LocalizedText }[];
  tasks: number;
  catalogs: number;
  /** Users with desktop data (preferences or wallpapers). */
  desktopUsers: string[];
}

/** Integrity check plus what the snapshot contains (read-only). */
export function inspectSnapshot(path: string): SnapshotSummary {
  const db = openDatabase(path, { readOnly: true });
  try {
    if (!db.quickCheck())
      return {
        ok: false,
        schemaVersion: 0,
        users: [],
        apps: [],
        tasks: 0,
        catalogs: 0,
        desktopUsers: [],
      };
    const count = (table: string) =>
      tableExists(db, table) ? db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n : 0;
    const desktop = new Set(
      db
        .all<{ user_id: string }>("SELECT DISTINCT user_id FROM user_preferences")
        .map((row) => row.user_id),
    );
    if (tableExists(db, "wallpapers"))
      for (const row of db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM wallpapers"))
        desktop.add(row.user_id);
    return {
      ok: true,
      schemaVersion: schemaVersionOf(db),
      users: db.all<{ id: string; username: string; role: string }>(
        "SELECT id, username, role FROM users ORDER BY username",
      ),
      apps: tableExists(db, "installed_apps")
        ? db
            .all<{ id: string; name: string }>(
              "SELECT id, name FROM installed_apps WHERE removed = 0 ORDER BY installed_at",
            )
            .map((row) => {
              let name: LocalizedText = {};
              try {
                name = JSON.parse(row.name) as LocalizedText;
              } catch {
                // Keep an empty name.
              }
              return { id: row.id, name };
            })
        : [],
      tasks: count("scheduled_tasks"),
      catalogs: count("catalogs"),
      desktopUsers: [...desktop],
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------ wallpapers */

/** Archives `<dataDir>/wallpapers/<userId>/<file>` (regular files only). */
export async function archiveWallpapers(root: string, target: string): Promise<number> {
  const users = await readdir(root).catch(() => [] as string[]);
  const files: Array<{ name: string; path: string; size: number; mtime: number }> = [];
  for (const user of users.sort()) {
    const dir = join(root, user);
    if (!(await lstat(dir)).isDirectory()) continue;
    for (const file of (await readdir(dir)).sort()) {
      const name = `wallpapers/${user}/${file}`;
      const info = await lstat(join(dir, file));
      if (info.isFile() && WALLPAPER_FILE.test(name))
        files.push({ name, path: join(dir, file), size: info.size, mtime: info.mtimeMs });
    }
  }
  if (files.length === 0) return 0;
  const gzip = createGzip({ level: 1 });
  const done = pipeline(gzip, createWriteStream(target, { flags: "wx", mode: 0o600 }));
  const writer = new TarWriter(sinkTo(gzip));
  for (const file of files) {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await writer.file(
        { name: file.name, size: file.size, mode: 0o600, mtime: file.mtime },
        handle.createReadStream({ autoClose: false }),
      );
    } finally {
      await handle.close();
    }
  }
  await writer.end();
  gzip.end();
  await done;
  return files.length;
}

/** Extracts the wallpapers of `users` from an archive into `target/<userId>/`. */
export async function extractWallpapers(
  archive: string,
  target: string,
  users: ReadonlySet<string> | null,
): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const gunzip = createGunzip();
  const source = createReadStream(archive);
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  for await (const entry of readTar(gunzip, { maxEntries: 10_000, maxBytes: 4 * 1024 ** 3 })) {
    const name = safeRelativePath(entry.name);
    if (entry.type !== "file" || !name || !WALLPAPER_FILE.test(name)) continue;
    const [, user, file] = name.split("/") as [string, string, string];
    if (users && !users.has(user)) continue;
    await mkdir(join(target, user), { recursive: true, mode: 0o700 });
    const handle = await open(join(target, user, file), "wx", 0o600);
    try {
      for await (const chunk of entry.content) await handle.write(chunk);
    } finally {
      await handle.close();
    }
  }
}

/** Replaces `dir` with `replacement` (rename aside, rename in, remove the old one). */
async function swapDirectory(dir: string, replacement: string): Promise<void> {
  const old = `${dir}.old-${randomBytes(4).toString("hex")}`;
  const existed = await lstat(dir)
    .then(() => true)
    .catch(() => false);
  if (existed) await rename(dir, old);
  try {
    await rename(replacement, dir);
  } catch (error) {
    if (existed) await rename(old, dir);
    throw error;
  }
  await rm(old, { recursive: true, force: true });
}

/* -------------------------------------------------------- desktop restore */

/**
 * Restores every matching user's desktop (layout, widgets, preferences and
 * wallpapers) from a snapshot into the live database, in place. Users are
 * matched by id; accounts themselves are not touched.
 */
export async function restoreDesktop(options: {
  db: Database;
  snapshot: string;
  wallpapersArchive: string | null;
  wallpapersDir: string;
  now: number;
}): Promise<string[]> {
  const { db } = options;
  const source = openDatabase(options.snapshot, { readOnly: true });
  let users: string[];
  let preferences: Array<{ user_id: string; key: string; value: string; updated_at: number }>;
  let wallpapers: Array<Record<string, string | number>>;
  try {
    const live = new Set(db.all<{ id: string }>("SELECT id FROM users").map((row) => row.id));
    users = source
      .all<{ id: string }>("SELECT id FROM users")
      .map((row) => row.id)
      .filter((id) => live.has(id));
    const placeholders = users.map(() => "?").join(",");
    preferences = users.length
      ? source.all(
          `SELECT user_id, key, value, updated_at FROM user_preferences WHERE user_id IN (${placeholders})`,
          ...users,
        )
      : [];
    // Rows name files on disk: only well-formed names are restored (never a path).
    wallpapers = (
      users.length && tableExists(source, "wallpapers")
        ? source.all<Record<string, string | number>>(
            `SELECT id, user_id, mime, size, width, height, file_name, created_at FROM wallpapers WHERE user_id IN (${placeholders})`,
            ...users,
          )
        : []
    ).filter((row) =>
      WALLPAPER_FILE.test(`wallpapers/${String(row.user_id)}/${String(row.file_name)}`),
    );
  } finally {
    source.close();
  }
  if (users.length === 0) return [];

  // Files first (staged next to the live directory), then rows, then swap.
  const staging = join(options.wallpapersDir, `.restore-${randomBytes(4).toString("hex")}`);
  await mkdir(options.wallpapersDir, { recursive: true, mode: 0o700 });
  try {
    if (options.wallpapersArchive)
      await extractWallpapers(options.wallpapersArchive, staging, new Set(users));
    db.transaction(() => {
      for (const user of users) {
        db.run("DELETE FROM user_preferences WHERE user_id = ?", user);
        db.run("DELETE FROM wallpapers WHERE user_id = ?", user);
      }
      for (const row of preferences)
        db.run(
          "INSERT INTO user_preferences(user_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
          row.user_id,
          row.key,
          row.value,
          options.now,
        );
      for (const row of wallpapers)
        db.run(
          "INSERT INTO wallpapers(id, user_id, mime, size, width, height, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          row.id!,
          row.user_id!,
          row.mime!,
          row.size!,
          row.width!,
          row.height!,
          row.file_name!,
          row.created_at!,
        );
    });
    for (const user of users) {
      const replacement = join(staging, user);
      const present = await lstat(replacement)
        .then(() => true)
        .catch(() => false);
      if (present) await swapDirectory(join(options.wallpapersDir, user), replacement);
      else await rm(join(options.wallpapersDir, user), { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return users;
}

/* ------------------------------------------------- staged database restore */

export interface PendingRestore {
  backupId: string;
  requestedBy: string | null;
  requestedAt: number;
}

const restoreDir = (dataDir: string) => join(dataDir, "restore");

/**
 * Prepares a full database restore, applied by `applyPendingRestore` when the
 * API starts next (an open database is never replaced underneath the server).
 */
export async function stageDatabaseRestore(options: {
  dataDir: string;
  snapshotGz: string;
  wallpapersArchive: string | null;
  pending: PendingRestore;
}): Promise<void> {
  const dir = restoreDir(options.dataDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  try {
    await gunzipFile(options.snapshotGz, join(dir, "everyos.db"));
    if (options.wallpapersArchive)
      await pipeline(
        createReadStream(options.wallpapersArchive),
        createWriteStream(join(dir, "wallpapers.tar.gz"), { flags: "wx", mode: 0o600 }),
      );
    // The marker last: a half-staged restore is never applied.
    await writeFile(join(dir, "pending.json"), JSON.stringify(options.pending), { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function pendingRestore(dataDir: string): Promise<PendingRestore | null> {
  try {
    return JSON.parse(
      await readFile(join(restoreDir(dataDir), "pending.json"), "utf8"),
    ) as PendingRestore;
  } catch {
    return null;
  }
}

export async function cancelPendingRestore(dataDir: string): Promise<void> {
  await rm(restoreDir(dataDir), { recursive: true, force: true });
}

/**
 * Applies a staged restore before the database is opened. The replaced
 * database is kept as `<backupDir>/pre-restore-<time>.db`. A staged restore
 * that fails its checks is set aside and the current database is kept.
 */
export async function applyPendingRestore(options: {
  dataDir: string;
  databaseFile: string;
  backupDir: string;
  logger: Logger;
  now?: number;
}): Promise<(PendingRestore & { previous: string | null }) | null> {
  const pending = await pendingRestore(options.dataDir);
  if (!pending) return null;
  const dir = restoreDir(options.dataDir);
  const staged = existsSync(join(dir, "everyos.db"))
    ? join(dir, "everyos.db")
    : join(dir, "otuken.db");
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  try {
    const check = openDatabase(staged, { readOnly: true });
    try {
      if (!check.quickCheck()) throw new Error("staged database failed its integrity check");
    } finally {
      check.close();
    }
  } catch (error) {
    options.logger.error("Staged restore is unusable; keeping the current database", { error });
    await rename(dir, `${dir}.failed-${stamp}`).catch(() =>
      rm(dir, { recursive: true, force: true }),
    );
    return null;
  }
  let previous: string | null = null;
  if (await lstat(options.databaseFile).catch(() => null)) {
    // Fold the WAL into the main file before moving it.
    const current = openDatabase(options.databaseFile);
    try {
      current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      current.close();
    }
    await mkdir(options.backupDir, { recursive: true, mode: 0o750 });
    previous = join(options.backupDir, `pre-restore-${stamp}.db`);
    await rename(options.databaseFile, previous);
    await removeDatabaseFiles(`${options.databaseFile}`).catch(() => undefined);
    // Keep the three most recent replaced databases.
    const old = (await readdir(options.backupDir))
      .filter((name) => /^pre-restore-.*\.db$/.test(name))
      .sort()
      .reverse()
      .slice(3);
    for (const name of old) await rm(join(options.backupDir, name), { force: true });
  }
  await rename(staged, options.databaseFile);
  const archive = join(dir, "wallpapers.tar.gz");
  const wallpapers = join(options.dataDir, "wallpapers");
  if (await lstat(archive).catch(() => null)) {
    const replacement = join(options.dataDir, `.wallpapers-restore-${stamp}`);
    await extractWallpapers(archive, replacement, null);
    await swapDirectory(wallpapers, replacement);
  } else {
    await rm(wallpapers, { recursive: true, force: true });
  }
  await rm(dir, { recursive: true, force: true });
  options.logger.info("Restored the database from a backup", {
    backupId: pending.backupId,
    previous,
  });
  return { ...pending, previous };
}
