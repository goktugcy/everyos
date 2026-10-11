import type { Migration } from "../migrator.ts";

/**
 * Notification center. A notification is visible to every user holding its
 * `permission` (or only to `user_id` when set); read and dismissed states are
 * per user. `dedupe_key` merges repeated events and identifies conditions.
 */
export const migration0008: Migration = {
  version: 8,
  name: "notifications",
  up(db) {
    db.exec(`
      CREATE TABLE notifications (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        category    TEXT NOT NULL,
        severity    TEXT NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'critical')),
        permission  TEXT NOT NULL,
        user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
        dedupe_key  TEXT NOT NULL,
        params      TEXT NOT NULL DEFAULT '{}',
        count       INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        notified_at INTEGER NOT NULL,
        resolved_at INTEGER
      ) STRICT;
      CREATE INDEX notifications_updated ON notifications(updated_at DESC, id);
      CREATE INDEX notifications_open ON notifications(dedupe_key) WHERE resolved_at IS NULL;

      CREATE TABLE notification_states (
        notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at         INTEGER,
        dismissed_at    INTEGER,
        PRIMARY KEY (notification_id, user_id)
      ) STRICT, WITHOUT ROWID;
    `);
  },
};
