import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  BACKUP_ID_PATTERN,
  type BackupManifest,
  type BackupVerification,
  type BackupView,
} from "@everyos/shared";
import { BACKUP_FILE_NAME, BackupManifestSchema } from "@everyos/shared/schemas";
import {
  archiveSize,
  readTar,
  TarError,
  TarWriter,
  type TarWriteHeader,
} from "@everyos/system/archive";
import { ApiError, notFound } from "../../http/errors.ts";

interface Info {
  pinned: boolean;
  uploaded: boolean;
  verification: BackupVerification | null;
}

const DEFAULT_INFO: Info = { pinned: false, uploaded: false, verification: null };

export const invalidBackup = (reason: string) =>
  new ApiError(400, "BACKUP_INVALID", "The backup archive is invalid", { details: { reason } });

/** `YYYYMMDD-HHMMSS-xxxxxx` in UTC: sortable and readable. */
export function newBackupId(now: number): string {
  const d = new Date(now);
  const p = (value: number) => String(value).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(3).toString("hex")}`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Refuses writes that would leave less than `reserve` bytes free on the backup disk. */
export class SpaceGuard {
  readonly #dir: string;
  readonly #reserve: number;
  #sinceCheck = 0;
  constructor(dir: string, reserve: number) {
    this.#dir = dir;
    this.#reserve = reserve;
  }
  async free(): Promise<number> {
    const fs = await statfs(this.#dir);
    return fs.bavail * fs.bsize;
  }
  /** Checks that `upcoming` more bytes still fit. */
  async require(upcoming: number): Promise<void> {
    const free = await this.free();
    if (free - upcoming < this.#reserve)
      throw new ApiError(507, "BACKUP_INSUFFICIENT_SPACE", "Not enough free space for the backup", {
        details: { freeBytes: free, neededBytes: upcoming, reserveBytes: this.#reserve },
      });
  }
  /** Call after writing `bytes`; re-checks the disk every 64 MiB. */
  async wrote(bytes: number): Promise<void> {
    this.#sinceCheck += bytes;
    if (this.#sinceCheck < 64 * 1024 * 1024) return;
    this.#sinceCheck = 0;
    await this.require(0);
  }
}

/**
 * Backups on disk (docs/backups.md): one private directory per backup with
 * checksummed files and manifest.json (written last, so incomplete backups
 * never look complete), plus info.json for mutable state (pin, verification).
 */
export class BackupStore {
  readonly dir: string;
  readonly #keyId: string;
  readonly #reserve: number;

  constructor(options: { dir: string; keyId: string; reserveBytes: number }) {
    this.dir = options.dir;
    this.#keyId = options.keyId;
    this.#reserve = options.reserveBytes;
  }

  guard(): SpaceGuard {
    return new SpaceGuard(this.dir, this.#reserve);
  }

  /** Creates the directory privately and refuses one others could tamper with. */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.dir);
    if (!info.isDirectory()) throw new Error(`Backup location is not a directory: ${this.dir}`);
    if (process.getuid && info.uid !== process.getuid())
      throw new Error(`Backup location must be owned by the EveryOS user: ${this.dir}`);
    if ((info.mode & 0o002) !== 0)
      throw new Error(`Backup location must not be world-writable: ${this.dir}`);
  }

  /** Removes leftovers of interrupted work. */
  async cleanup(): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (/^\.(partial|upload|work)-/.test(name))
        await rm(join(this.dir, name), { recursive: true, force: true });
    }
  }

  #path(id: string): string {
    if (!BACKUP_ID_PATTERN.test(id)) throw notFound("Backup");
    return join(this.dir, id);
  }

  /** Absolute path of a file inside a backup (names are checked against the allow-list). */
  file(id: string, name: string): string {
    if (!BACKUP_FILE_NAME.test(name)) throw notFound("Backup file");
    return join(this.#path(id), name);
  }

  async manifest(id: string): Promise<BackupManifest> {
    let text: string;
    try {
      text = await readFile(join(this.#path(id), "manifest.json"), "utf8");
    } catch {
      throw notFound("Backup");
    }
    const parsed = BackupManifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw invalidBackup("manifest");
    return parsed.data;
  }

  async databaseFile(id: string): Promise<string> {
    const manifest = await this.manifest(id);
    const files = manifest.files.filter(
      (file) => file.name === "everyos.db.gz" || file.name === "otuken.db.gz",
    );
    if (files.length !== 1) throw invalidBackup("database");
    return this.file(id, files[0]!.name);
  }

  async #info(id: string): Promise<Info> {
    try {
      return {
        ...DEFAULT_INFO,
        ...(JSON.parse(await readFile(join(this.#path(id), "info.json"), "utf8")) as Info),
      };
    } catch {
      return { ...DEFAULT_INFO };
    }
  }

  async #writeInfo(id: string, info: Info): Promise<void> {
    const target = join(this.#path(id), "info.json");
    await writeFile(`${target}.tmp`, JSON.stringify(info), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }

  #view(manifest: BackupManifest, info: Info): BackupView {
    return {
      id: manifest.id,
      createdAt: manifest.createdAt,
      trigger: manifest.trigger,
      createdBy: manifest.createdBy,
      note: manifest.note,
      everyosVersion: manifest.everyosVersion,
      schemaVersion: manifest.schemaVersion,
      hostname: manifest.hostname,
      size: manifest.files.reduce((sum, file) => sum + file.size, 0),
      contents: manifest.contents,
      pinned: info.pinned,
      uploaded: info.uploaded,
      sameKey: manifest.keyId === this.#keyId,
      verification: info.verification,
    };
  }

  async view(id: string): Promise<BackupView> {
    return this.#view(await this.manifest(id), await this.#info(id));
  }

  /** Every complete backup, newest first (unreadable ones are skipped). */
  async list(): Promise<BackupView[]> {
    const views: BackupView[] = [];
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!BACKUP_ID_PATTERN.test(name)) continue;
      try {
        views.push(await this.view(name));
      } catch {
        // Not a complete or readable backup; leave it alone.
      }
    }
    return views.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  /** Starts a backup in a private work directory. */
  async begin(id: string): Promise<string> {
    const work = join(this.dir, `.partial-${id}`);
    await mkdir(join(work, "apps"), { recursive: true, mode: 0o700 });
    return work;
  }

  /** Writes the manifest and publishes the backup atomically. */
  async publish(work: string, manifest: BackupManifest, info: Partial<Info> = {}): Promise<void> {
    await writeFile(join(work, "manifest.json"), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(work, "info.json"), JSON.stringify({ ...DEFAULT_INFO, ...info }), {
      mode: 0o600,
    });
    await rename(work, this.#path(manifest.id));
  }

  async discard(work: string): Promise<void> {
    await rm(work, { recursive: true, force: true });
  }

  async remove(id: string): Promise<void> {
    await this.manifest(id);
    // Make it incomplete first, so an interrupted removal never leaves a "valid" half.
    await rm(join(this.#path(id), "manifest.json"), { force: true });
    await rm(this.#path(id), { recursive: true, force: true });
  }

  async setPinned(id: string, pinned: boolean): Promise<BackupView> {
    await this.manifest(id);
    await this.#writeInfo(id, { ...(await this.#info(id)), pinned });
    return this.view(id);
  }

  async setVerification(id: string, verification: BackupVerification): Promise<void> {
    await this.#writeInfo(id, { ...(await this.#info(id)), verification });
  }

  /** Checks presence, sizes and SHA-256 of every file; returns the first problem or null. */
  async checkFiles(id: string): Promise<string | null> {
    const manifest = await this.manifest(id);
    const expected = new Set(["manifest.json", "info.json", "apps"]);
    for (const file of manifest.files) {
      expected.add(file.name);
      const path = this.file(id, file.name);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) return `missing:${file.name}`;
      if (info.size !== file.size) return `size:${file.name}`;
      if ((await sha256File(path)) !== file.sha256) return `checksum:${file.name}`;
    }
    const present = [
      ...(await readdir(this.#path(id))),
      ...(await readdir(join(this.#path(id), "apps")).catch(() => [])).map((n) => `apps/${n}`),
    ];
    const extra = present.find((name) => !expected.has(name) && !name.endsWith(".tmp"));
    return extra ? `unexpected:${extra}` : null;
  }

  /* ------------------------------------------------------------ transfer */

  #downloadEntries(manifest: BackupManifest): Array<TarWriteHeader & { path: string | null }> {
    const top = `everyos-backup-${manifest.id}`;
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2));
    return [
      { name: top, type: "directory", mode: 0o700, mtime: manifest.createdAt, path: null },
      {
        name: `${top}/manifest.json`,
        type: "file",
        size: manifestBytes,
        mode: 0o600,
        mtime: manifest.createdAt,
        path: null,
      },
      ...manifest.files.map((file) => ({
        name: `${top}/${file.name}`,
        type: "file" as const,
        size: file.size,
        mode: 0o600,
        mtime: manifest.createdAt,
        path: this.file(manifest.id, file.name),
      })),
    ];
  }

  /** The backup as one tar archive (its exact size and a writer for it). */
  async download(id: string): Promise<{
    size: number;
    name: string;
    write: (sink: (chunk: Buffer) => Promise<void>) => Promise<void>;
  }> {
    const manifest = await this.manifest(id);
    const entries = this.#downloadEntries(manifest);
    return {
      size: archiveSize(entries),
      name: `everyos-backup-${id}.tar`,
      write: async (sink) => {
        const writer = new TarWriter(sink);
        for (const entry of entries) {
          if (entry.type === "directory") await writer.directory(entry);
          else if (entry.type === "file" && entry.path === null)
            await writer.file(entry, Buffer.from(JSON.stringify(manifest, null, 2)));
          else if (entry.type === "file") {
            const handle = await open(entry.path!, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              await writer.file(entry, handle.createReadStream({ autoClose: false }));
            } finally {
              await handle.close();
            }
          }
        }
        await writer.end();
      },
    };
  }

  /**
   * Imports an archive produced by `download`: only the expected file names,
   * every checksum verified, no overwriting of an existing backup.
   */
  async importArchive(
    source: AsyncIterable<Buffer | Uint8Array>,
    maxBytes: number,
  ): Promise<string> {
    const work = join(this.dir, `.upload-${randomBytes(6).toString("hex")}`);
    await mkdir(join(work, "apps"), { recursive: true, mode: 0o700 });
    const guard = this.guard();
    await guard.require(0);
    try {
      let top: string | null = null;
      const written = new Map<string, { size: number; sha256: string }>();
      for await (const entry of readTar(source, { maxEntries: 200, maxBytes })) {
        const [first, ...rest] = entry.name.split("/");
        if (!first || !/^(?:everyos|otuken)-backup-\d{8}-\d{6}-[a-f0-9]{6}$/.test(first))
          throw invalidBackup("layout");
        top ??= first;
        if (first !== top) throw invalidBackup("layout");
        const name = rest.join("/");
        if (entry.type === "directory" && (name === "" || name === "apps")) continue;
        if (entry.type !== "file" || !BACKUP_FILE_NAME.test(name) || written.has(name))
          throw invalidBackup("entry");
        const hash = createHash("sha256");
        const handle = await open(join(work, name), "wx", 0o600);
        let size = 0;
        try {
          for await (const chunk of entry.content) {
            await handle.write(chunk);
            hash.update(chunk);
            size += chunk.length;
            await guard.wrote(chunk.length);
          }
        } finally {
          await handle.close();
        }
        written.set(name, { size, sha256: hash.digest("hex") });
      }
      if (!top || !written.has("manifest.json")) throw invalidBackup("manifest");
      const parsed = BackupManifestSchema.safeParse(
        JSON.parse(await readFile(join(work, "manifest.json"), "utf8")),
      );
      if (
        !parsed.success ||
        (top !== `everyos-backup-${parsed.data.id}` && top !== `otuken-backup-${parsed.data.id}`)
      )
        throw invalidBackup("manifest");
      const manifest = parsed.data;
      if (written.size !== manifest.files.length + 1) throw invalidBackup("files");
      for (const file of manifest.files) {
        const actual = written.get(file.name);
        if (!actual || actual.size !== file.size || actual.sha256 !== file.sha256)
          throw invalidBackup(`checksum:${file.name}`);
      }
      if (await lstat(this.#path(manifest.id)).catch(() => null))
        throw new ApiError(409, "CONFLICT", "This backup is already present");
      await writeFile(
        join(work, "info.json"),
        JSON.stringify({ ...DEFAULT_INFO, uploaded: true }),
        { mode: 0o600 },
      );
      await rename(work, this.#path(manifest.id));
      return manifest.id;
    } catch (error) {
      await rm(work, { recursive: true, force: true });
      if (error instanceof TarError) throw invalidBackup("archive");
      if (error instanceof SyntaxError) throw invalidBackup("manifest");
      throw error;
    }
  }

  async usage(): Promise<{ freeBytes: number | null; usedBytes: number }> {
    const backups = await this.list();
    const freeBytes = await this.guard()
      .free()
      .catch(() => null);
    return { freeBytes, usedBytes: backups.reduce((sum, backup) => sum + backup.size, 0) };
  }
}
