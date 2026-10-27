import type { Database } from "@everyos/database";

/** What each person decided for each installed app (for now: whether it may notify them). */
export class AppUserSettings {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  get(appId: string, userId: string): { notifications: boolean } {
    const row = this.#db.get<{ notifications: number }>(
      "SELECT notifications FROM desktop_app_user_settings WHERE app_id = ? AND user_id = ?",
      appId,
      userId,
    );
    return { notifications: row ? row.notifications === 1 : true };
  }

  notificationsEnabled(appId: string, userId: string): boolean {
    return this.get(appId, userId).notifications;
  }

  set(appId: string, userId: string, settings: { notifications: boolean }): void {
    this.#db.run(
      `INSERT INTO desktop_app_user_settings(app_id, user_id, notifications, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id, user_id) DO UPDATE SET notifications = excluded.notifications, updated_at = excluded.updated_at`,
      appId,
      userId,
      settings.notifications ? 1 : 0,
      this.#now(),
    );
  }
}
