import type { Migration } from "../migrator.ts";

/** Each person's Google Drive connection; the refresh token is context-bound SecretBox ciphertext. */
export const migration0015: Migration = {
  version: 15,
  name: "drive-accounts",
  up(db) {
    db.exec(`
      CREATE TABLE drive_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT,
        sealed_token TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('connected', 'reconnect')),
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
};
