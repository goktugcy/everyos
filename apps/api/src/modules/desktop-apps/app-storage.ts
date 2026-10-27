import type { Database } from "@everyos/database";
import { ApiError } from "../../http/errors.ts";

/** Per person and app: a key-value store of JSON values. */
export const APP_STORAGE_LIMITS = {
  quotaBytes: 16 * 1024 * 1024,
  valueBytes: 256 * 1024,
  keyLength: 256,
  keys: 10_000,
};

const full = () =>
  new ApiError(507, "DESKTOP_APP_STORAGE_FULL", "The app's storage is full", {
    details: { quota: APP_STORAGE_LIMITS.quotaBytes },
  });

/**
 * App data, isolated by the server-side identity of the app and the person: an app never names
 * its own id or the user, so it cannot reach another app's or another person's data.
 */
export class AppStorage {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  get(appId: string, userId: string, key: string): { value: unknown } | null {
    const row = this.#db.get<{ value: string }>(
      "SELECT value FROM desktop_app_storage WHERE app_id = ? AND user_id = ? AND key = ?",
      appId,
      userId,
      key,
    );
    return row ? { value: JSON.parse(row.value) as unknown } : null;
  }

  usage(appId: string, userId: string): { used: number; quota: number; keys: number } {
    const row = this.#db.get<{ used: number | null; keys: number }>(
      "SELECT sum(size) AS used, count(*) AS keys FROM desktop_app_storage WHERE app_id = ? AND user_id = ?",
      appId,
      userId,
    );
    return { used: row?.used ?? 0, quota: APP_STORAGE_LIMITS.quotaBytes, keys: row?.keys ?? 0 };
  }

  set(appId: string, userId: string, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (json === undefined) throw new ApiError(400, "VALIDATION_FAILED", "Not a JSON value");
    const size = Buffer.byteLength(json) + Buffer.byteLength(key);
    if (size > APP_STORAGE_LIMITS.valueBytes)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The value is too large");
    this.#db.transaction(() => {
      const previous = this.#db.get<{ size: number }>(
        "SELECT size FROM desktop_app_storage WHERE app_id = ? AND user_id = ? AND key = ?",
        appId,
        userId,
        key,
      );
      const usage = this.usage(appId, userId);
      if (!previous && usage.keys >= APP_STORAGE_LIMITS.keys) throw full();
      if (usage.used - (previous?.size ?? 0) + size > APP_STORAGE_LIMITS.quotaBytes) throw full();
      this.#db.run(
        `INSERT INTO desktop_app_storage(app_id, user_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id, user_id, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at`,
        appId,
        userId,
        key,
        json,
        size,
        this.#now(),
      );
    });
  }

  delete(appId: string, userId: string, key: string): void {
    this.#db.run(
      "DELETE FROM desktop_app_storage WHERE app_id = ? AND user_id = ? AND key = ?",
      appId,
      userId,
      key,
    );
  }

  keys(appId: string, userId: string, prefix: string): Array<{ key: string; size: number }> {
    // Filtered here: SQLite counts characters where JavaScript counts UTF-16 units, and LIKE would
    // treat % and _ in keys as wildcards.
    return this.#db
      .all<{ key: string; size: number }>(
        "SELECT key, size FROM desktop_app_storage WHERE app_id = ? AND user_id = ? ORDER BY key",
        appId,
        userId,
      )
      .filter((row) => row.key.startsWith(prefix));
  }

  clear(appId: string, userId: string): void {
    this.#db.run("DELETE FROM desktop_app_storage WHERE app_id = ? AND user_id = ?", appId, userId);
  }
}
