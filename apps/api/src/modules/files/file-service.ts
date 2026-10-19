import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import {
  cp,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Logger } from "@everyos/logger";
import {
  MAX_TEXT_FILE_BYTES,
  STANDARD_FOLDERS,
  type FileEntry,
  type FileEntryType,
  type FileListing,
  type FileProperties,
  type FileRootKind,
  type FileRootView,
  type FileSearchResult,
  type StandardFolder,
  type TextFile,
  type TrashListing,
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
} from "@everyos/shared";
import { ApiError, notFound } from "../../http/errors.ts";
import {
  discardTrashItem,
  listTrash,
  putInTrash,
  readTrashItem,
  trashDirectory,
  trashPayload,
  TRASH_DIRECTORY,
} from "./trash.ts";

export interface FileRootConfig {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
  kind?: FileRootKind;
  /** Home only: the owner's language, for the names of new standard folders. */
  locale?: string;
}

/**
 * Read-only Linux locations administrators may turn on. Only those that exist
 * are offered; the API's own user decides what is actually readable.
 */
export const SYSTEM_ROOTS = [
  { id: "sys-root", path: "/" },
  { id: "sys-home", path: "/home" },
  { id: "sys-etc", path: "/etc" },
  { id: "sys-log", path: "/var/log" },
  { id: "sys-srv", path: "/srv" },
  { id: "sys-mnt", path: "/mnt" },
  { id: "sys-media", path: "/media" },
  { id: "sys-opt", path: "/opt" },
] as const;

/** Kernel pseudo file systems are never browsed through "/" (reads can block or leak). */
const PSEUDO = new Set(["proc", "sys", "dev"]);

/** Standard folder names as each language's desktops (xdg-user-dirs) name them. */
const FOLDER_NAMES: Record<Locale, Record<StandardFolder, string>> = {
  tr: {
    desktop: "Masaüstü",
    documents: "Belgeler",
    downloads: "İndirilenler",
    pictures: "Resimler",
    music: "Müzik",
    videos: "Videolar",
  },
  en: {
    desktop: "Desktop",
    documents: "Documents",
    downloads: "Downloads",
    pictures: "Pictures",
    music: "Music",
    videos: "Videos",
  },
  de: {
    desktop: "Schreibtisch",
    documents: "Dokumente",
    downloads: "Downloads",
    pictures: "Bilder",
    music: "Musik",
    videos: "Videos",
  },
  es: {
    desktop: "Escritorio",
    documents: "Documentos",
    downloads: "Descargas",
    pictures: "Imágenes",
    music: "Música",
    videos: "Vídeos",
  },
  fr: {
    desktop: "Bureau",
    documents: "Documents",
    downloads: "Téléchargements",
    pictures: "Images",
    music: "Musique",
    videos: "Vidéos",
  },
  it: {
    desktop: "Scrivania",
    documents: "Documenti",
    downloads: "Scaricati",
    pictures: "Immagini",
    music: "Musica",
    videos: "Video",
  },
  ja: {
    desktop: "デスクトップ",
    documents: "ドキュメント",
    downloads: "ダウンロード",
    pictures: "画像",
    music: "音楽",
    videos: "ビデオ",
  },
  ko: {
    desktop: "바탕화면",
    documents: "문서",
    downloads: "다운로드",
    pictures: "사진",
    music: "음악",
    videos: "비디오",
  },
  ru: {
    desktop: "Рабочий стол",
    documents: "Документы",
    downloads: "Загрузки",
    pictures: "Изображения",
    music: "Музыка",
    videos: "Видео",
  },
  zh: {
    desktop: "桌面",
    documents: "文档",
    downloads: "下载",
    pictures: "图片",
    music: "音乐",
    videos: "视频",
  },
};

/** Remembers which folder is which, so a later language change keeps the existing names. */
const FOLDERS_MANIFEST = ".otuken-folders.json";

const MAX_LIST_ENTRIES = 5_000;
const MAX_CHILD_COUNT = 10_000;
const SEARCH_LIMITS = { results: 300, visited: 50_000, depth: 16, ms: 8_000 };
const COPY_SCAN_LIMIT = 200_000;
const STAT_CONCURRENCY = 32;
type AccessState = { count: number; idle: Set<() => void> };
type FileAccess = Map<string, AccessState>;

/** Thrown for paths that do not exist or resolve outside their root (indistinguishable on purpose). */
const missing = () => notFound("File");
const invalid = (message: string) => new ApiError(400, "VALIDATION_FAILED", message);

function segmentsOf(path: string): string[] {
  if (path.length > 4096 || path.includes("\0") || path.startsWith("/"))
    throw invalid("Invalid path");
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || Buffer.byteLength(s) > 255))
    throw invalid("Invalid path");
  return segments;
}

function checkName(name: string): string {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    name === TRASH_DIRECTORY ||
    Buffer.byteLength(name) > 255
  )
    throw invalid("Invalid name");
  return name;
}

function validFolderName(name: string): boolean {
  try {
    checkName(name);
    return name !== FOLDERS_MANIFEST;
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function typeOf(stats: Stats): FileEntryType {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function modeString(mode: number): string {
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : "-";
  return out;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Maps file system errors to API errors without leaking host paths. */
function fsError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  switch (errno(error)) {
    case "ENOENT":
    case "ENOTDIR":
    case "ELOOP":
      throw missing();
    case "EEXIST":
    case "ENOTEMPTY":
      throw new ApiError(409, "CONFLICT", "An item with this name already exists");
    case "EACCES":
    case "EPERM":
    case "EROFS":
      throw new ApiError(403, "FORBIDDEN", "The server is not allowed to change this item");
    case "ENOSPC":
    case "EDQUOT":
      throw new ApiError(507, "FILES_INSUFFICIENT_SPACE", "Not enough free space");
    case "EISDIR":
      throw invalid("This is a folder");
    case undefined:
    default:
      throw error;
  }
}

/** Owner and group names from /etc/passwd and /etc/group (numbers elsewhere). */
export class IdNames {
  #users: Map<number, string> | null = null;
  #groups: Map<number, string> | null = null;
  #loadedAt = 0;

  async names(uid: number, gid: number): Promise<{ owner: string; group: string }> {
    if (Date.now() - this.#loadedAt > 60_000) {
      this.#users = await this.#read("/etc/passwd");
      this.#groups = await this.#read("/etc/group");
      this.#loadedAt = Date.now();
    }
    return {
      owner: this.#users?.get(uid) ?? String(uid),
      group: this.#groups?.get(gid) ?? String(gid),
    };
  }

  async #read(file: string): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        const [name, , id] = line.split(":");
        if (name && id && /^\d+$/.test(id)) map.set(Number(id), name);
      }
    } catch {
      // Not every platform has these files; numbers are shown instead.
    }
    return map;
  }
}

/**
 * File manager backend (docs/files.md). It runs as the API's own unprivileged
 * user, inside administrator-configured roots only. Every path is resolved to
 * its canonical form and must stay inside its root; final components are
 * opened without following symlinks, and links that point outside a root are
 * shown but never followed. The operating system remains the final boundary:
 * the API user can only touch what it may touch anyway.
 */
export class FileService {
  readonly #roots: Map<string, FileRootConfig>;
  readonly #maxUploadBytes: number;
  readonly #minFreeBytes: number;
  readonly #logger: Logger;
  readonly #ids: IdNames;
  readonly #homesDir: string | null;
  readonly #trashOwner: string | null;
  readonly #homeLocks: Set<string>;
  readonly #access: FileAccess;
  readonly #extraRoots: () => readonly FileRootConfig[];

  constructor(options: {
    roots: readonly FileRootConfig[];
    maxUploadBytes: number;
    minFreeBytes: number;
    logger: Logger;
    homesDir?: string | null;
    ids?: IdNames;
    trashOwner?: string | null;
    homeLocks?: Set<string>;
    access?: FileAccess;
    /** Locations that come and go (mounted disks), shared like configured ones. */
    extraRoots?: () => readonly FileRootConfig[];
  }) {
    this.#extraRoots = options.extraRoots ?? (() => []);
    this.#roots = new Map(options.roots.map((root) => [root.id, root]));
    this.#maxUploadBytes = options.maxUploadBytes;
    this.#minFreeBytes = options.minFreeBytes;
    this.#logger = options.logger.child({ component: "files" });
    this.#ids = options.ids ?? new IdNames();
    this.#homesDir = options.homesDir ?? null;
    this.#trashOwner = options.trashOwner ?? null;
    this.#homeLocks = options.homeLocks ?? new Set();
    this.#access = options.access ?? new Map<string, AccessState>();
  }

  /**
   * The locations one user sees: their private home (when enabled), the
   * configured locations, and, for administrators who turned them on, the
   * read-only system paths. Every route works on such a view.
   */
  view(user: {
    id: string;
    username: string;
    locale: string;
    systemRoots: boolean;
    personalOnly?: boolean;
  }): FileService {
    const roots: FileRootConfig[] = [];
    if (this.#homesDir)
      roots.push({
        id: "home",
        name: user.username,
        path: join(this.#homesDir, user.id),
        readOnly: false,
        kind: "home",
        locale: user.locale,
      });
    if (!user.personalOnly) roots.push(...this.#roots.values(), ...this.#extraRoots());
    if (user.systemRoots && !user.personalOnly)
      for (const root of SYSTEM_ROOTS)
        roots.push({
          id: root.id,
          name: root.path,
          path: root.path,
          readOnly: true,
          kind: "system",
        });
    return new FileService({
      roots,
      maxUploadBytes: this.#maxUploadBytes,
      minFreeBytes: this.#minFreeBytes,
      logger: this.#logger,
      ids: this.#ids,
      trashOwner: user.id,
      homeLocks: this.#homeLocks,
      access: this.#access,
    });
  }

  get enabled(): boolean {
    return this.#roots.size > 0 || this.#homesDir !== null;
  }

  get maxUploadBytes(): number {
    return this.#maxUploadBytes;
  }

  get homesDir(): string | null {
    return this.#homesDir;
  }

  /** Home replacement excludes file requests until the new directory is in place. */
  async withHomesLocked<T>(users: readonly string[], run: () => Promise<T>): Promise<T> {
    if (users.some((id) => this.#homeLocks.has(id)))
      throw new ApiError(409, "CONFLICT", "A home restore is already running");
    users.forEach((id) => this.#homeLocks.add(id));
    try {
      await Promise.all(
        users.map((id) => {
          const access = this.#access.get(id);
          return access?.count
            ? new Promise<void>((resolve) => access.idle.add(resolve))
            : Promise.resolve();
        }),
      );
      return await run();
    } finally {
      users.forEach((id) => this.#homeLocks.delete(id));
    }
  }

  async withAccess<T>(userId: string, run: () => Promise<T>): Promise<T> {
    if (this.#homeLocks.has(userId))
      throw new ApiError(409, "CONFLICT", "The home is being backed up or restored");
    const access = this.#access.get(userId) ?? { count: 0, idle: new Set<() => void>() };
    this.#access.set(userId, access);
    access.count++;
    try {
      return await run();
    } finally {
      access.count--;
      if (!access.count) {
        access.idle.forEach((resolve) => resolve());
        this.#access.delete(userId);
      }
    }
  }

  /** Creates missing development roots (production roots must already exist). */
  async ensureRoots(): Promise<void> {
    for (const root of this.#roots.values())
      await mkdir(root.path, { recursive: true, mode: 0o750 });
  }

  async roots(canWrite: boolean): Promise<FileRootView[]> {
    const views = await Promise.all(
      [...this.#roots.values()].map(async (root): Promise<FileRootView> => {
        const kind = root.kind ?? "location";
        this.#root(root.id);
        const folders = kind === "home" ? await this.#ensureHome(root) : null;
        return {
          id: root.id,
          name: root.name,
          kind,
          readOnly: root.readOnly || !canWrite,
          available: await stat(root.path).then(
            (s) => s.isDirectory(),
            () => false,
          ),
          ...(folders ? { folders } : {}),
        };
      }),
    );
    // System paths that do not exist on this host are not offered at all.
    return views.filter((view) => view.kind !== "system" || view.available);
  }

  /** Creates the home and its standard folders (again, if one was removed outside EveryOS). */
  async #ensureHome(root: FileRootConfig): Promise<Record<StandardFolder, string>> {
    await mkdir(root.path, { recursive: true, mode: 0o700 });
    const names = await this.#folderNames(root);
    for (const kind of STANDARD_FOLDERS)
      await mkdir(join(root.path, names[kind]), { mode: 0o750 }).catch((error: unknown) => {
        if (errno(error) !== "EEXIST") throw error;
      });
    return names;
  }

  async #folderNames(root: FileRootConfig): Promise<Record<StandardFolder, string>> {
    const manifest = join(root.path, FOLDERS_MANIFEST);
    let saved: Partial<Record<StandardFolder, unknown>> = {};
    try {
      const handle = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size <= 16_384) {
          const value: unknown = JSON.parse(await handle.readFile("utf8"));
          if (value !== null && typeof value === "object" && !Array.isArray(value)) saved = value;
        }
      } finally {
        await handle.close();
      }
      if (
        STANDARD_FOLDERS.every(
          (kind) => typeof saved[kind] === "string" && validFolderName(saved[kind]),
        ) &&
        new Set(Object.values(saved)).size === STANDARD_FOLDERS.length
      )
        return saved as Record<StandardFolder, string>;
    } catch {
      // First use (or a damaged manifest): name the folders in the owner's language.
    }
    // Names already given stay; folders added in a later version get the owner's language.
    const fresh = FOLDER_NAMES[isLocale(root.locale) ? root.locale : DEFAULT_LOCALE];
    const used = new Set<string>();
    const names = Object.fromEntries(
      STANDARD_FOLDERS.map((kind) => {
        const name = saved[kind];
        let candidate =
          typeof name === "string" && validFolderName(name) && !used.has(name) ? name : fresh[kind];
        while (used.has(candidate)) candidate += " 2";
        used.add(candidate);
        return [kind, candidate];
      }),
    ) as Record<StandardFolder, string>;
    await mkdir(root.path, { recursive: true, mode: 0o700 });
    const handle = await open(
      manifest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    ).catch(fsError);
    try {
      await handle.writeFile(JSON.stringify(names));
    } finally {
      await handle.close();
    }
    return names;
  }

  /** Standard home folders stay where they are: no rename, move or delete. */
  async #protect(rootId: string, paths: readonly string[]): Promise<void> {
    const root = this.#root(rootId);
    if (root.kind !== "home") return;
    const names = new Set(Object.values(await this.#folderNames(root)));
    names.add(FOLDERS_MANIFEST);
    for (const path of paths) {
      const segments = segmentsOf(path);
      const source = await this.#entryPath(rootId, path, { notRoot: true });
      if (
        (segments.length === 1 && names.has(segments[0]!)) ||
        (source.parent === source.rootReal && names.has(basename(source.entry)))
      )
        throw new ApiError(403, "FILES_PROTECTED", "Standard folders cannot be changed", {
          details: { name: segments[0] },
        });
    }
  }

  /* -------------------------------- reading -------------------------------- */

  async list(rootId: string, path: string, hidden: boolean): Promise<FileListing> {
    const { real, rootReal } = await this.#follow(rootId, path);
    const directory = await stat(real).catch(fsError);
    if (!directory.isDirectory()) throw invalid("Not a folder");
    const dirents = await readdir(real, { withFileTypes: true }).catch(fsError);
    const top = rootId === "sys-root" && segmentsOf(path).length === 0;
    const visible = dirents.filter(
      (d) =>
        d.name !== TRASH_DIRECTORY &&
        (hidden || !d.name.startsWith(".")) &&
        !(top && PSEUDO.has(d.name)),
    );
    const slice = visible.slice(0, MAX_LIST_ENTRIES);
    const entries: FileEntry[] = [];
    for (let i = 0; i < slice.length; i += STAT_CONCURRENCY) {
      const batch = await Promise.all(
        slice.slice(i, i + STAT_CONCURRENCY).map((d) => this.#entry(rootReal, real, d.name)),
      );
      for (const entry of batch) if (entry) entries.push(entry);
    }
    return {
      root: rootId,
      path: segmentsOf(path).join("/"),
      entries,
      truncated: visible.length > slice.length,
    };
  }

  async properties(rootId: string, path: string): Promise<FileProperties> {
    const { entry, rootReal, segments } = await this.#entryPath(rootId, path);
    const stats = await lstat(entry).catch(fsError);
    const type = typeOf(stats);
    const ids = await this.#ids.names(stats.uid, stats.gid);
    let children: number | null = null;
    if (type === "directory") {
      children = 0;
      const dir = await opendir(entry).catch(fsError);
      for await (const _ of dir) if (++children >= MAX_CHILD_COUNT) break;
    }
    return {
      root: rootId,
      path: segments.join("/"),
      name: segments.at(-1) ?? this.#root(rootId).name,
      type,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      changedAt: stats.ctimeMs,
      createdAt: stats.birthtimeMs > 0 ? stats.birthtimeMs : null,
      mode: modeString(stats.mode),
      octal: (stats.mode & 0o7777).toString(8).padStart(4, "0"),
      ...ids,
      children,
      link: type === "symlink" ? await this.#linkInfo(rootReal, entry) : null,
    };
  }

  /** Opens a regular file for streaming (the caller closes the handle). */
  async openFile(
    rootId: string,
    path: string,
  ): Promise<{ handle: FileHandle; size: number; modifiedAt: number; name: string }> {
    const { real } = await this.#follow(rootId, path);
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(fsError);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw invalid("Not a file");
      return { handle, size: stats.size, modifiedAt: stats.mtimeMs, name: basename(real) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readText(rootId: string, path: string): Promise<TextFile> {
    const { handle, size, modifiedAt } = await this.openFile(rootId, path);
    try {
      if (size > MAX_TEXT_FILE_BYTES)
        throw new ApiError(413, "FILES_TOO_LARGE", "The file is too large to edit here");
      const buffer = await handle.readFile();
      if (buffer.subarray(0, 8192).includes(0))
        throw new ApiError(415, "FILES_NOT_TEXT", "This is not a text file");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new ApiError(415, "FILES_NOT_TEXT", "This file is not UTF-8 text");
      }
      return { content, etag: etagOf(buffer.length, modifiedAt), size: buffer.length, modifiedAt };
    } finally {
      await handle.close();
    }
  }

  async search(rootId: string, path: string, query: string): Promise<FileSearchResult> {
    const { real, rootReal } = await this.#follow(rootId, path);
    const needle = query.normalize("NFC").toLocaleLowerCase("tr");
    const base = segmentsOf(path);
    const results: FileSearchResult["results"] = [];
    const deadline = Date.now() + SEARCH_LIMITS.ms;
    const queue: Array<{ dir: string; rel: string[]; depth: number }> = [
      { dir: real, rel: base, depth: 0 },
    ];
    let visited = 0;
    let truncated = false;
    while (queue.length > 0) {
      const { dir, rel, depth } = queue.shift()!;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // Unreadable folders are skipped, not errors.
      }
      for (const dirent of dirents) {
        if (dirent.name === TRASH_DIRECTORY) continue;
        if (
          ++visited > SEARCH_LIMITS.visited ||
          Date.now() > deadline ||
          results.length >= SEARCH_LIMITS.results
        ) {
          truncated = true;
          return { results, truncated };
        }
        const type: FileEntryType = dirent.isDirectory()
          ? "directory"
          : dirent.isFile()
            ? "file"
            : dirent.isSymbolicLink()
              ? "symlink"
              : "other";
        if (dirent.name.normalize("NFC").toLocaleLowerCase("tr").includes(needle))
          results.push({ path: [...rel, dirent.name].join("/"), name: dirent.name, type });
        // Symlinked folders are never descended into.
        if (type === "directory" && depth < SEARCH_LIMITS.depth) {
          if (rootId === "sys-root" && rel.length === 0 && PSEUDO.has(dirent.name)) continue;
          const child = join(dir, dirent.name);
          if (inside(rootReal, child))
            queue.push({ dir: child, rel: [...rel, dirent.name], depth: depth + 1 });
        }
      }
    }
    return { results, truncated };
  }

  /* -------------------------------- writing -------------------------------- */

  async writeText(
    rootId: string,
    path: string,
    content: string,
    etag: string | null,
  ): Promise<TextFile> {
    await this.#protect(rootId, [path]);
    this.#writable(rootId);
    const { entry, parent } = await this.#entryPath(rootId, path, { notRoot: true });
    const data = Buffer.from(content, "utf8");
    if (data.length > MAX_TEXT_FILE_BYTES)
      throw new ApiError(413, "FILES_TOO_LARGE", "Text is too large");
    const existing = await lstat(entry).catch((error: unknown) =>
      errno(error) === "ENOENT" ? null : fsError(error),
    );
    if (etag === null) {
      if (existing) throw new ApiError(409, "CONFLICT", "An item with this name already exists");
      await this.#ensureSpace(parent, data.length);
      const handle = await open(
        entry,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o640,
      ).catch(fsError);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    } else {
      if (!existing?.isFile()) throw missing();
      if (etagOf(existing.size, existing.mtimeMs) !== etag)
        throw new ApiError(409, "CONFLICT", "The file changed since it was opened");
      await this.#ensureSpace(parent, data.length);
      if (existing.uid === process.getuid?.()) {
        // Own files are replaced atomically, keeping their permissions.
        const temp = join(parent, `.${basename(entry)}.everyos-${randomUUID()}.tmp`);
        const handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          existing.mode & 0o777,
        ).catch(fsError);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, entry).catch(async (error: unknown) => {
          await unlink(temp).catch(() => undefined);
          fsError(error);
        });
      } else {
        // Someone else's file (group-writable): write in place so owner and mode stay.
        const handle = await open(
          entry,
          constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
        ).catch(fsError);
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
      }
    }
    const after = await stat(entry).catch(fsError);
    return {
      content,
      etag: etagOf(after.size, after.mtimeMs),
      size: after.size,
      modifiedAt: after.mtimeMs,
    };
  }

  async mkdir(rootId: string, path: string, name: string): Promise<void> {
    this.#writable(rootId);
    const { real } = await this.#follow(rootId, path);
    await mkdir(join(real, checkName(name)), { mode: 0o750 }).catch(fsError);
  }

  async rename(rootId: string, path: string, name: string): Promise<void> {
    this.#writable(rootId);
    await this.#protect(rootId, [path]);
    const { entry, parent } = await this.#entryPath(rootId, path, { notRoot: true });
    const target = join(parent, checkName(name));
    if (target === entry) return;
    await lstat(entry).catch(fsError);
    if (await exists(target))
      throw new ApiError(409, "CONFLICT", "An item with this name already exists");
    await rename(entry, target).catch(fsError);
  }

  /** Streams an upload to a temporary file, then links it into place (no silent overwrite). */
  async upload(
    rootId: string,
    path: string,
    name: string,
    body: WebReadableStream<Uint8Array>,
    length: number,
    overwrite: boolean,
  ): Promise<void> {
    this.#writable(rootId);
    if (length > this.#maxUploadBytes)
      throw new ApiError(413, "FILES_TOO_LARGE", "The file is larger than the upload limit");
    await this.#protect(rootId, [[path, name].filter(Boolean).join("/")]);
    const { real } = await this.#follow(rootId, path);
    const target = join(real, checkName(name));
    if (!overwrite && (await exists(target)))
      throw new ApiError(409, "CONFLICT", "An item with this name already exists");
    await this.#ensureSpace(real, length);
    const temp = join(real, `.everyos-upload-${randomUUID()}.part`);
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(
          received > length
            ? new ApiError(400, "VALIDATION_FAILED", "Upload is longer than announced")
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(body),
        counter,
        createWriteStream(temp, { flags: "wx", mode: 0o640 }),
      );
      if (received !== length) throw new ApiError(400, "VALIDATION_FAILED", "Upload ended early");
      if (overwrite) {
        const current = await lstat(target).catch(() => null);
        if (current?.isDirectory())
          throw new ApiError(409, "CONFLICT", "A folder with this name exists");
        await rename(temp, target);
      } else {
        await link(temp, target).catch(async (error: unknown) => {
          // Some file systems (exFAT, network shares) cannot hard-link.
          if (errno(error) !== "EPERM" && errno(error) !== "ENOTSUP" && errno(error) !== "EXDEV")
            throw error;
          if (await exists(target))
            throw new ApiError(409, "CONFLICT", "An item with this name already exists");
          await rename(temp, target);
        });
      }
    } catch (error) {
      fsError(error);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async copy(
    rootId: string,
    paths: readonly string[],
    destination: { root: string; path: string },
    name?: string,
  ): Promise<void> {
    this.#writable(destination.root);
    if (name !== undefined && paths.length !== 1)
      throw invalid("A new name needs exactly one item");
    const { real: target } = await this.#follow(destination.root, destination.path);
    const sources = await this.#sources(rootId, paths);
    let bytes = 0;
    for (const source of sources) {
      if (inside(source.entry, target)) throw invalid("A folder cannot be copied into itself");
      bytes += await treeSize(source.entry);
    }
    await this.#ensureSpace(target, bytes);
    for (const source of sources) {
      const dest = join(target, checkName(name ?? basename(source.entry)));
      if (await exists(dest))
        throw new ApiError(409, "CONFLICT", "An item with this name already exists", {
          details: { name: basename(dest) },
        });
      await cp(source.entry, dest, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        // Links are copied as links, never followed (they may point outside the root).
        verbatimSymlinks: true,
      }).catch(fsError);
    }
  }

  async move(
    rootId: string,
    paths: readonly string[],
    destination: { root: string; path: string },
  ): Promise<void> {
    this.#writable(rootId);
    this.#writable(destination.root);
    await this.#protect(rootId, paths);
    const { real: target } = await this.#follow(destination.root, destination.path);
    const sources = await this.#sources(rootId, paths);
    for (const source of sources) {
      if (inside(source.entry, target)) throw invalid("A folder cannot be moved into itself");
      const dest = join(target, basename(source.entry));
      if (dest === source.entry) continue;
      if (await exists(dest))
        throw new ApiError(409, "CONFLICT", "An item with this name already exists", {
          details: { name: basename(dest) },
        });
      try {
        await rename(source.entry, dest);
      } catch (error) {
        if (errno(error) !== "EXDEV") fsError(error);
        // Another file system: copy, then remove the original.
        await this.#ensureSpace(target, await treeSize(source.entry));
        await cp(source.entry, dest, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        }).catch(fsError);
        await rm(source.entry, { recursive: true }).catch(fsError);
      }
    }
  }

  async remove(rootId: string, paths: readonly string[]): Promise<void> {
    this.#writable(rootId);
    await this.#protect(rootId, paths);
    const sources = await this.#sources(rootId, paths);
    const base = await this.#trash(rootId, true);
    for (const source of sources.filter(
      (candidate, index) =>
        !sources.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            inside(other.entry, candidate.entry) &&
            (other.entry !== candidate.entry || otherIndex < index),
        ),
    )) {
      const info = await lstat(source.entry).catch(fsError);
      await putInTrash(base, source.entry, {
        root: rootId,
        path: source.segments.join("/"),
        name: basename(source.entry),
        type: typeOf(info),
        size: info.size,
      }).catch(fsError);
    }
  }

  async trash(): Promise<TrashListing> {
    const entries: TrashListing["entries"] = [];
    let truncated = false;
    for (const root of this.#roots.values()) {
      if (root.kind === "system") continue;
      try {
        const listing = await listTrash(await this.#trash(root.id), root.id);
        entries.push(...listing.entries);
        truncated ||= listing.truncated;
      } catch (error) {
        if (
          !["ENOENT", "EACCES", "EPERM"].includes(errno(error) ?? "") &&
          !(error instanceof ApiError && ["NOT_FOUND", "FORBIDDEN"].includes(error.code))
        )
          throw error;
      }
    }
    entries.sort((a, b) => b.deletedAt - a.deletedAt);
    return { entries, truncated };
  }

  async restoreTrash(rootId: string, ids: readonly string[]): Promise<void> {
    this.#writable(rootId);
    const base = await this.#trash(rootId);
    for (const id of new Set(ids)) {
      const item = await readTrashItem(base, rootId, id).catch(fsError);
      await this.#protect(rootId, [item.path]);
      const { entry, parent } = await this.#entryPath(rootId, item.path, { notRoot: true });
      if (await exists(entry))
        throw new ApiError(409, "CONFLICT", "The original name is already in use");
      const payload = await trashPayload(base, id);
      const info = await lstat(payload).catch(fsError);
      if (info.isDirectory()) {
        // Reserve the original name; rename only replaces our empty reservation.
        await mkdir(entry, { mode: 0o700 }).catch(fsError);
        try {
          await rename(payload, entry).catch(fsError);
        } catch (error) {
          await rmdir(entry).catch(() => undefined);
          throw error;
        }
      } else {
        try {
          await link(payload, entry);
        } catch (error) {
          if (!["EPERM", "ENOTSUP", "EXDEV"].includes(errno(error) ?? "")) fsError(error);
          if (info.isSymbolicLink()) await symlink(await readlink(payload), entry).catch(fsError);
          else if (info.isFile()) {
            await this.#ensureSpace(parent, info.size);
            await copyFile(payload, entry, constants.COPYFILE_EXCL).catch(fsError);
          } else fsError(error);
        }
        await unlink(payload).catch(fsError);
      }
      await discardTrashItem(base, id).catch(fsError);
    }
  }

  async deleteTrash(rootId: string, ids: readonly string[]): Promise<void> {
    this.#writable(rootId);
    const base = await this.#trash(rootId);
    for (const id of new Set(ids)) {
      await readTrashItem(base, rootId, id).catch(fsError);
      await discardTrashItem(base, id).catch(fsError);
    }
  }

  async #trash(rootId: string, create = false): Promise<string> {
    if (!this.#trashOwner) throw new ApiError(403, "FORBIDDEN", "No trash owner");
    return trashDirectory(await this.#rootReal(rootId), this.#trashOwner, create).catch(fsError);
  }

  /* -------------------------------- helpers -------------------------------- */

  #root(rootId: string): FileRootConfig {
    const root = this.#roots.get(rootId);
    if (!root) throw missing();
    if (root.kind === "home" && this.#trashOwner && this.#homeLocks.has(this.#trashOwner))
      throw new ApiError(409, "CONFLICT", "The home is being restored");
    return root;
  }

  #writable(rootId: string): void {
    if (this.#root(rootId).readOnly)
      throw new ApiError(403, "FILES_READ_ONLY", "This location is read-only");
  }

  async #rootReal(rootId: string): Promise<string> {
    const root = this.#root(rootId);
    // A home and its standard folders are created on first use.
    if (root.kind === "home" && !(await exists(root.path))) await this.#ensureHome(root);
    return realpath(root.path).catch(() => {
      throw new ApiError(404, "NOT_FOUND", "This location is not available");
    });
  }

  /** Segments of a path, refusing kernel pseudo file systems under "/". */
  #segments(rootId: string, path: string): string[] {
    const segments = segmentsOf(path);
    if (segments.includes(TRASH_DIRECTORY)) throw missing();
    if (rootId === "sys-root" && PSEUDO.has(segments[0] ?? "")) throw missing();
    return segments;
  }

  /** Canonical path of an existing item; symlinks are followed but must stay inside the root. */
  async #follow(rootId: string, path: string): Promise<{ real: string; rootReal: string }> {
    const segments = this.#segments(rootId, path);
    const rootReal = await this.#rootReal(rootId);
    const real = await realpath(join(rootReal, ...segments)).catch(() => {
      throw missing();
    });
    if (!inside(rootReal, real) || real.split(sep).includes(TRASH_DIRECTORY)) throw missing();
    return { real, rootReal };
  }

  /** The item itself (a symlink is not followed); its parent must resolve inside the root. */
  async #entryPath(
    rootId: string,
    path: string,
    options: { notRoot?: boolean } = {},
  ): Promise<{ entry: string; parent: string; rootReal: string; segments: string[] }> {
    const segments = this.#segments(rootId, path);
    const rootReal = await this.#rootReal(rootId);
    if (segments.length === 0) {
      if (options.notRoot)
        throw new ApiError(403, "FORBIDDEN", "The root itself cannot be changed");
      return { entry: rootReal, parent: dirname(rootReal), rootReal, segments };
    }
    const parent = await realpath(join(rootReal, ...segments.slice(0, -1))).catch(() => {
      throw missing();
    });
    if (!inside(rootReal, parent) || parent.split(sep).includes(TRASH_DIRECTORY)) throw missing();
    return { entry: join(parent, segments.at(-1)!), parent, rootReal, segments };
  }

  async #sources(rootId: string, paths: readonly string[]) {
    const sources = [];
    for (const path of paths) {
      const source = await this.#entryPath(rootId, path, { notRoot: true });
      await lstat(source.entry).catch(fsError);
      sources.push(source);
    }
    return sources;
  }

  async #entry(rootReal: string, dir: string, name: string): Promise<FileEntry | null> {
    const path = join(dir, name);
    try {
      const stats = await lstat(path);
      const type = typeOf(stats);
      return {
        name,
        type,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        mode: modeString(stats.mode),
        link: type === "symlink" ? await this.#linkInfo(rootReal, path) : null,
      };
    } catch {
      return null; // Vanished while listing.
    }
  }

  async #linkInfo(rootReal: string, path: string): Promise<FileEntry["link"]> {
    try {
      await readlink(path);
      const target = await realpath(path);
      if (!inside(rootReal, target) || target.split(sep).includes(TRASH_DIRECTORY))
        return { inside: false };
      const stats = await stat(target);
      return {
        type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        inside: true,
      };
    } catch {
      return { inside: false }; // Broken link.
    }
  }

  async #ensureSpace(dir: string, bytes: number): Promise<void> {
    // The reserve keeps the system's filesystem usable; an added disk may be filled up.
    let reserve = this.#minFreeBytes;
    for (const root of this.#roots.values())
      if (root.kind === "disk" && inside(await realpath(root.path).catch(() => root.path), dir))
        reserve = 0;
    try {
      const fs = await statfs(dir);
      const available = Number(fs.bavail) * Number(fs.bsize);
      if (bytes + reserve > available)
        throw new ApiError(507, "FILES_INSUFFICIENT_SPACE", "Not enough free space", {
          details: {
            requiredBytes: bytes,
            availableBytes: available,
            reserveBytes: reserve,
          },
        });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.#logger.debug("Free space check unavailable", { error });
    }
  }
}

function etagOf(size: number, modifiedAt: number): string {
  return `${size.toString(36)}-${Math.trunc(modifiedAt * 1000).toString(36)}`;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** Total size of a file or tree (links count as links); bounded walk. */
async function treeSize(path: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stats = await lstat(current).catch(() => null);
    if (!stats) continue;
    if (++seen > COPY_SCAN_LIMIT) throw invalid("Too many items to copy at once");
    total += stats.isDirectory() ? 0 : stats.size;
    if (stats.isDirectory()) {
      for (const name of await readdir(current).catch(() => [])) stack.push(join(current, name));
    }
  }
  return total;
}
