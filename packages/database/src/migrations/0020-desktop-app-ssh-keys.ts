import type { Migration } from "../migrator.ts";

/**
 * Each person's own SSH keys, kept for apps holding secrets:ssh. Private keys are sealed with the
 * server secret; only an export the person confirms ever reveals one.
 */
export const migration0020: Migration = {
  version: 20,
  name: "desktop-app-ssh-keys",
  up(db) {
    db.exec(`
      CREATE TABLE desktop_app_ssh_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        bits INTEGER NOT NULL,
        comment TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        public_key TEXT NOT NULL,
        sealed_private TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_id, fingerprint)
      ) STRICT;
    `);
  },
};
