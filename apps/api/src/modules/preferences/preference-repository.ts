import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import { PREFERENCE_KEYS, type PreferenceKey } from "@everyos/shared";
import { PREFERENCE_SCHEMAS, type PreferenceDocuments } from "@everyos/shared/schemas";

interface PreferenceRow {
  key: string;
  value: string;
}

/**
 * Per-user preference documents (desktop layout, appearance, dock, …). Each
 * document is validated on write and again on read, so a document written by
 * an older release that no longer matches the schema is ignored (the client
 * falls back to defaults) instead of breaking the desktop.
 */
export class PreferenceRepository {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(db: Database, logger: Logger, now: () => number = Date.now) {
    this.#db = db;
    this.#logger = logger.child({ component: "preferences" });
    this.#now = now;
  }

  getAll(userId: string): Partial<PreferenceDocuments> {
    const rows = this.#db.all<PreferenceRow>(
      "SELECT key, value FROM user_preferences WHERE user_id = ?",
      userId,
    );
    const out: Partial<Record<PreferenceKey, unknown>> = {};
    for (const row of rows) {
      if (!(PREFERENCE_KEYS as readonly string[]).includes(row.key)) continue;
      const key = row.key as PreferenceKey;
      try {
        const parsed = PREFERENCE_SCHEMAS[key].safeParse(JSON.parse(row.value));
        if (parsed.success) out[key] = parsed.data;
        else
          this.#logger.warn("Ignoring stored preference that no longer matches its schema", {
            key,
            userId,
          });
      } catch {
        this.#logger.warn("Ignoring unreadable stored preference", { key, userId });
      }
    }
    return out as Partial<PreferenceDocuments>;
  }

  set(userId: string, key: PreferenceKey, value: unknown): void {
    this.#db.run(
      `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      userId,
      key,
      JSON.stringify(value),
      this.#now(),
    );
  }

  delete(userId: string, key: PreferenceKey): void {
    this.#db.run("DELETE FROM user_preferences WHERE user_id = ? AND key = ?", userId, key);
  }
}
