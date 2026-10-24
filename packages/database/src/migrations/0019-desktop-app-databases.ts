import type { Migration } from "../migrator.ts";

/**
 * Databases administrators connect for desktop apps holding database:connect. The password is
 * sealed with the server secret and never leaves the server.
 */
export const migration0019: Migration = {
  version: 19,
  name: "desktop-app-databases",
  up(db) {
    db.exec(`
      CREATE TABLE desktop_app_db_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('postgres', 'mysql')),
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database TEXT NOT NULL,
        username TEXT NOT NULL,
        sealed_password TEXT,
        tls TEXT NOT NULL CHECK(tls IN ('disable', 'require', 'verify')),
        access TEXT NOT NULL CHECK(access IN ('read', 'write')),
        audience TEXT NOT NULL CHECK(audience IN ('admins', 'everyone')),
        app_id TEXT REFERENCES desktop_app_installations(app_id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX desktop_app_db_connections_name
        ON desktop_app_db_connections(name, COALESCE(app_id, ''));
    `);
  },
};
