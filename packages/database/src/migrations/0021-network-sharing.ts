import type { Migration } from "../migrator.ts";

export const migration0021: Migration = {
  version: 21,
  name: "network-sharing",
  up(db) {
    db.exec(`
      CREATE TABLE network_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        config TEXT NOT NULL,
        sealed_credentials TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX network_connections_owner ON network_connections(user_id);
      CREATE TABLE network_shares (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX network_shares_owner ON network_shares(user_id);
      CREATE TABLE quick_shares (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        sealed_token TEXT NOT NULL,
        password_hash TEXT,
        config TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0,
        bytes_received INTEGER NOT NULL DEFAULT 0,
        reserved_bytes INTEGER NOT NULL DEFAULT 0,
        uploads INTEGER NOT NULL DEFAULT 0,
        reserved_uploads INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        claimed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX quick_shares_owner ON quick_shares(user_id);
      CREATE INDEX quick_shares_expiry ON quick_shares(expires_at);
      CREATE TABLE quick_share_grants (
        hash TEXT PRIMARY KEY,
        share_id TEXT NOT NULL REFERENCES quick_shares(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
};
