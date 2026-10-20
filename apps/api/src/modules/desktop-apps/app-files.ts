import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Database } from "@everyos/database";
import { ApiError, notFound } from "../../http/errors.ts";
import type { FileUser, FileView } from "../files/file-view.ts";

export interface FileGrantRow {
  id: string;
  app_id: string;
  user_id: string;
  root: string;
  path: string;
  kind: "file" | "directory";
  mode: "read" | "readwrite";
  persistent: number;
  instance: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface FileHandleView {
  id: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  type: string | null;
  writable: boolean;
  persistent: boolean;
}

const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  vtt: "text/vtt",
  srt: "application/x-subrip",
};

export function mimeOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (MIME[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** Most grants one app holds for one person. */
const MAX_GRANTS = 512;
/** A write that stays idle this long is abandoned. */
const WRITE_IDLE_MS = 10 * 60_000;
/** Media URLs live this long; the app asks again when one expires. */
const URL_TTL_MS = 30 * 60_000;

interface WriteSession {
  instance: string;
  file: string;
  written: number;
  lastAt: number;
}

interface MediaUrl {
  grant: string;
  appId: string;
  user: FileUser;
  root: string;
  path: string;
  expiresAt: number;
}

const segments = (path: string) => path.split("/").filter(Boolean);

/**
 * Files an app may reach for a person: only items that person picked in the EveryOS picker
 * (grants), never anything else. Folder grants reach inside the folder but never through links.
 */
export class AppFiles {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #dir: string;
  readonly #writes = new Map<string, WriteSession>();
  readonly #urls = new Map<string, MediaUrl>();

  constructor(options: { db: Database; now: () => number; dir: string }) {
    this.#db = options.db;
    this.#now = options.now;
    this.#dir = options.dir;
    // Temporary grants belonged to windows of a previous run.
    this.#db.run("DELETE FROM desktop_app_file_grants WHERE persistent = 0");
  }

  view(row: FileGrantRow, size: number | null): FileHandleView {
    return {
      id: row.id,
      name: segments(row.path).at(-1) ?? row.root,
      kind: row.kind,
      size: row.kind === "file" ? size : null,
      type: row.kind === "file" ? mimeOf(row.path) : null,
      writable: row.mode === "readwrite",
      persistent: row.persistent === 1,
    };
  }

  grant(input: {
    appId: string;
    userId: string;
    instance: string;
    root: string;
    path: string;
    kind: "file" | "directory";
    writable: boolean;
    persistent: boolean;
  }): FileGrantRow {
    const count = this.#db.get<{ count: number }>(
      "SELECT count(*) AS count FROM desktop_app_file_grants WHERE app_id = ? AND user_id = ?",
      input.appId,
      input.userId,
    )!.count;
    if (count >= MAX_GRANTS)
      throw new ApiError(409, "CONFLICT", "The app already holds too many file grants");
    const row: FileGrantRow = {
      id: randomBytes(16).toString("base64url"),
      app_id: input.appId,
      user_id: input.userId,
      root: input.root,
      path: segments(input.path).join("/"),
      kind: input.kind,
      mode: input.writable ? "readwrite" : "read",
      persistent: input.persistent ? 1 : 0,
      instance: input.persistent ? null : input.instance,
      created_at: this.#now(),
      expires_at: null,
    };
    this.#db.run(
      `INSERT INTO desktop_app_file_grants(id, app_id, user_id, root, path, kind, mode, persistent, instance, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.app_id,
      row.user_id,
      row.root,
      row.path,
      row.kind,
      row.mode,
      row.persistent,
      row.instance,
      row.created_at,
      row.expires_at,
    );
    return row;
  }

  /** A grant of this app and person (temporary ones only for the window that got them). */
  find(id: string, appId: string, userId: string, instance: string): FileGrantRow {
    const row = this.#db.get<FileGrantRow>(
      "SELECT * FROM desktop_app_file_grants WHERE id = ? AND app_id = ? AND user_id = ?",
      id,
      appId,
      userId,
    );
    if (!row || (row.persistent === 0 && row.instance !== instance)) throw notFound("File handle");
    return row;
  }

  list(appId: string, userId: string, instance: string): FileGrantRow[] {
    return this.#db.all<FileGrantRow>(
      `SELECT * FROM desktop_app_file_grants WHERE app_id = ? AND user_id = ? AND (persistent = 1 OR instance = ?)
       ORDER BY created_at`,
      appId,
      userId,
      instance,
    );
  }

  revoke(id: string, appId: string, userId: string): void {
    this.#db.run(
      "DELETE FROM desktop_app_file_grants WHERE id = ? AND app_id = ? AND user_id = ?",
      id,
      appId,
      userId,
    );
    for (const [token, url] of this.#urls) if (url.grant === id) this.#urls.delete(token);
  }

  /** Ends a window's temporary grants and unfinished writes. */
  endInstance(instance: string): void {
    const ids = this.#db
      .all<{ id: string }>(
        "SELECT id FROM desktop_app_file_grants WHERE instance = ? AND persistent = 0",
        instance,
      )
      .map((row) => row.id);
    this.#db.run(
      "DELETE FROM desktop_app_file_grants WHERE instance = ? AND persistent = 0",
      instance,
    );
    for (const id of ids)
      for (const [token, url] of this.#urls) if (url.grant === id) this.#urls.delete(token);
    for (const [key, session] of this.#writes)
      if (session.instance === instance) void this.#discard(key);
  }

  /**
   * The root path of an item inside a grant. Every segment below the grant must be a real folder
   * (or, last, a file): a link would lead outside what the person picked.
   */
  async resolve(
    view: FileView,
    grant: FileGrantRow,
    relative: string,
    expect: "file" | "directory" | "any",
  ): Promise<{ path: string; kind: "file" | "directory"; size: number }> {
    const parts = segments(relative);
    if (parts.some((part) => part === "." || part === "..")) throw notFound("File");
    if (grant.kind === "file" && parts.length) throw notFound("File");
    let path = grant.path;
    let properties = await view.properties(grant.root, path);
    for (const part of parts) {
      if (properties.type !== "directory") throw notFound("File");
      path = path ? `${path}/${part}` : part;
      properties = await view.properties(grant.root, path);
    }
    if (properties.type !== "file" && properties.type !== "directory") throw notFound("File");
    if (expect !== "any" && properties.type !== expect) throw notFound("File");
    return { path, kind: properties.type, size: properties.size };
  }

  /* ----------------------------------------------------------------- writes */

  async #discard(key: string): Promise<void> {
    const session = this.#writes.get(key);
    this.#writes.delete(key);
    if (session) await rm(session.file, { force: true });
  }

  /**
   * One sequential chunk of a whole-file write; `done` commits it through the person's file view
   * (an atomic replace there). Chunks wait in the API's own data directory meanwhile.
   */
  async write(input: {
    view: FileView;
    grant: FileGrantRow;
    instance: string;
    offset: number;
    data: Buffer;
    done: boolean;
    maxBytes: number;
  }): Promise<{ size: number }> {
    const { grant } = input;
    if (grant.mode !== "readwrite" || grant.kind !== "file")
      throw new ApiError(403, "FORBIDDEN", "This handle is read-only");
    const key = `${grant.id}:${input.instance}`;
    const now = this.#now();
    for (const [other, session] of this.#writes)
      if (now - session.lastAt > WRITE_IDLE_MS) await this.#discard(other);
    if (input.offset === 0) await this.#discard(key);
    let session = this.#writes.get(key);
    if (!session) {
      if (input.offset !== 0) throw new ApiError(409, "CONFLICT", "The write was interrupted");
      await mkdir(join(this.#dir, "writes"), { recursive: true, mode: 0o700 });
      session = {
        instance: input.instance,
        file: join(this.#dir, "writes", randomUUID()),
        written: 0,
        lastAt: now,
      };
      this.#writes.set(key, session);
    }
    if (input.offset !== session.written) {
      await this.#discard(key);
      throw new ApiError(409, "CONFLICT", "Chunks must arrive in order");
    }
    if (session.written + input.data.length > input.maxBytes) {
      await this.#discard(key);
      throw new ApiError(413, "FILES_TOO_LARGE", "The file is larger than the upload limit");
    }
    await appendFile(session.file, input.data, { mode: 0o600 });
    const received = input.data.length;
    session.written += received;
    session.lastAt = this.#now();
    if (!input.done) return { size: session.written };
    try {
      const size = (await stat(session.file)).size;
      const parts = segments(grant.path);
      await input.view.upload(
        grant.root,
        parts.slice(0, -1).join("/"),
        parts.at(-1)!,
        Readable.toWeb(createReadStream(session.file)) as WebReadableStream<Uint8Array>,
        size,
        true,
      );
      return { size };
    } finally {
      await this.#discard(key);
    }
  }

  /* ------------------------------------------------------------ media URLs */

  issueUrl(input: Omit<MediaUrl, "expiresAt">): { url: string; expiresAt: number } {
    const now = this.#now();
    for (const [token, url] of this.#urls) if (url.expiresAt <= now) this.#urls.delete(token);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + URL_TTL_MS;
    this.#urls.set(token, { ...input, expiresAt });
    return { url: `/app-files/${token}`, expiresAt };
  }

  mediaUrl(token: string): MediaUrl | null {
    const url = this.#urls.get(token);
    if (!url) return null;
    if (url.expiresAt <= this.#now()) {
      this.#urls.delete(token);
      return null;
    }
    return url;
  }

  /** Whether a grant still exists (a media URL dies with its grant). */
  exists(id: string): boolean {
    return Boolean(this.#db.get("SELECT 1 FROM desktop_app_file_grants WHERE id = ?", id));
  }
}
