import type { Migration } from "../migrator.ts";

/**
 * Desktop shell support: server-enforced session locking and per-user
 * uploaded wallpapers (files live under <dataDir>/wallpapers/<userId>/).
 */
export const migration0002: Migration = {
  version: 2,
  name: "desktop",
  up(db) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN locked_at INTEGER;

      CREATE TABLE wallpapers (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
        size       INTEGER NOT NULL,
        width      INTEGER NOT NULL,
        height     INTEGER NOT NULL,
        file_name  TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX wallpapers_user_idx ON wallpapers(user_id);
    `);
  },
};
