import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Database } from "@otuken/database";
import { randomToken } from "@otuken/security";
import {
  MAX_WALLPAPER_BYTES,
  MAX_WALLPAPERS_PER_USER,
  type WallpaperInfo,
  type WallpaperMimeType,
} from "@otuken/shared";
import { ApiError } from "../../http/errors.ts";
import { probeImage } from "./image-probe.ts";

/** Largest accepted edge; bigger images are decompression-bomb territory for browsers. */
export const MAX_WALLPAPER_EDGE = 8192;
/** Uploads are refused when the data volume would drop below this much free space. */
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const HEADER_BYTES = 512 * 1024;
const EXTENSIONS: Record<WallpaperMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

interface WallpaperRow {
  id: string;
  user_id: string;
  mime: WallpaperMimeType;
  size: number;
  width: number;
  height: number;
  file_name: string;
  created_at: number;
}

const toInfo = (row: WallpaperRow): WallpaperInfo => ({
  id: row.id,
  mime: row.mime,
  size: row.size,
  width: row.width,
  height: row.height,
  createdAt: row.created_at,
});

const invalid = () => new ApiError(400, "WALLPAPER_INVALID", "Unsupported or corrupt image");

/** Stores user-uploaded wallpapers under <dataDir>/wallpapers/<userId>/. */
export class WallpaperService {
  readonly #db: Database;
  readonly #root: string;
  readonly #now: () => number;

  constructor(db: Database, dataDir: string, now: () => number = Date.now) {
    this.#db = db;
    this.#root = join(dataDir, "wallpapers");
    this.#now = now;
  }

  list(userId: string): WallpaperInfo[] {
    return this.#db
      .all<WallpaperRow>(
        "SELECT * FROM wallpapers WHERE user_id = ? ORDER BY created_at DESC",
        userId,
      )
      .map(toInfo);
  }

  /** Returns the file of a wallpaper owned by `userId`, or null. */
  file(userId: string, id: string): { path: string; mime: WallpaperMimeType; size: number } | null {
    const row = this.#db.get<WallpaperRow>(
      "SELECT * FROM wallpapers WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    return row
      ? { path: join(this.#root, userId, row.file_name), mime: row.mime, size: row.size }
      : null;
  }

  /**
   * Streams an upload to disk with a hard size cap, then verifies the bytes
   * are a supported image of sane dimensions. Nothing is kept on failure.
   */
  async store(
    userId: string,
    declaredLength: number | null,
    body: WebReadableStream<Uint8Array>,
  ): Promise<WallpaperInfo> {
    if (declaredLength !== null && declaredLength > MAX_WALLPAPER_BYTES) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Image too large");
    }
    const count =
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM wallpapers WHERE user_id = ?", userId)
        ?.n ?? 0;
    if (count >= MAX_WALLPAPERS_PER_USER) {
      throw new ApiError(409, "WALLPAPER_QUOTA_EXCEEDED", "Wallpaper quota exceeded");
    }

    const dir = join(this.#root, userId);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const space = await statfs(dir);
    if (space.bavail * space.bsize < MIN_FREE_BYTES + MAX_WALLPAPER_BYTES) {
      throw new ApiError(507, "WALLPAPER_QUOTA_EXCEEDED", "Not enough free disk space");
    }

    const id = randomToken(16);
    const temp = join(dir, `.upload-${id}`);
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_WALLPAPER_BYTES)
          callback(new ApiError(413, "PAYLOAD_TOO_LARGE", "Image too large"));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(body),
        limiter,
        createWriteStream(temp, { mode: 0o640, flags: "wx" }),
      );
      if (size === 0) throw invalid();

      const handle = await open(temp, "r");
      let info;
      try {
        const header = Buffer.alloc(Math.min(HEADER_BYTES, size));
        await handle.read(header, 0, header.length, 0);
        info = probeImage(header);
      } finally {
        await handle.close();
      }
      if (!info || info.width < 1 || info.height < 1) throw invalid();
      if (info.width > MAX_WALLPAPER_EDGE || info.height > MAX_WALLPAPER_EDGE) throw invalid();

      const fileName = `${id}.${EXTENSIONS[info.mime]}`;
      await rename(temp, join(dir, fileName));
      const createdAt = this.#now();
      this.#db.run(
        `INSERT INTO wallpapers (id, user_id, mime, size, width, height, file_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        info.mime,
        size,
        info.width,
        info.height,
        fileName,
        createdAt,
      );
      return { id, mime: info.mime, size, width: info.width, height: info.height, createdAt };
    } catch (error) {
      await rm(temp, { force: true });
      if (error instanceof ApiError) throw error;
      throw invalid();
    }
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const row = this.#db.get<WallpaperRow>(
      "SELECT * FROM wallpapers WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!row) return false;
    this.#db.run("DELETE FROM wallpapers WHERE id = ?", id);
    await rm(join(this.#root, userId, row.file_name), { force: true });
    return true;
  }

  /** Removes every stored file of a user (called when the account is deleted). */
  async deleteAllForUser(userId: string): Promise<void> {
    await rm(join(this.#root, userId), { recursive: true, force: true });
  }
}
