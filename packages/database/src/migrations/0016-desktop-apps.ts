import type { Migration } from "../migrator.ts";

/**
 * Desktop apps (docs/app-sdk/architecture.md): signed registries, server-wide installations with
 * their granted capabilities, and each person's app data and file grants.
 */
export const migration0016: Migration = {
  version: 16,
  name: "desktop-apps",
  up(db) {
    db.exec(`
      CREATE TABLE desktop_app_registries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('official', 'community', 'private')),
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        sealed_token TEXT,
        allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        sequence INTEGER NOT NULL DEFAULT -1,
        index_json TEXT,
        synced_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE desktop_app_installations (
        app_id TEXT PRIMARY KEY,
        registry_id TEXT REFERENCES desktop_app_registries(id) ON DELETE SET NULL,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        signature TEXT NOT NULL,
        publisher_key TEXT NOT NULL,
        runtime_key TEXT NOT NULL UNIQUE,
        granted TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'disabled', 'revoked')),
        state_reason TEXT,
        previous_version TEXT,
        installed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE desktop_app_storage (
        app_id TEXT NOT NULL REFERENCES desktop_app_installations(app_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, user_id, key)
      ) STRICT;

      CREATE TABLE desktop_app_file_grants (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES desktop_app_installations(app_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file', 'directory')),
        mode TEXT NOT NULL CHECK(mode IN ('read', 'readwrite')),
        persistent INTEGER NOT NULL CHECK(persistent IN (0, 1)),
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT;
      CREATE INDEX desktop_app_file_grants_owner ON desktop_app_file_grants(app_id, user_id);

      CREATE TABLE desktop_app_user_settings (
        app_id TEXT NOT NULL REFERENCES desktop_app_installations(app_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notifications INTEGER NOT NULL DEFAULT 1 CHECK(notifications IN (0, 1)),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, user_id)
      ) STRICT;

      CREATE TABLE desktop_app_network_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('host', 'cidr')),
        pattern TEXT NOT NULL,
        ports TEXT NOT NULL,
        note TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (kind, pattern, ports)
      ) STRICT;
    `);
  },
};
