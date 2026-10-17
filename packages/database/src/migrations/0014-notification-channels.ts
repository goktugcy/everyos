import type { Migration } from "../migrator.ts";

/** External notification channels; credentials are context-bound SecretBox ciphertext. */
export const migration0014: Migration = {
  version: 14,
  name: "notification-channels",
  up(db) {
    db.exec(`
      CREATE TABLE notification_channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('ntfy', 'telegram', 'email', 'webhook')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        min_severity TEXT NOT NULL,
        categories TEXT NOT NULL,
        language TEXT NOT NULL,
        sealed_config TEXT NOT NULL,
        last_delivery_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
};
