import type { Migration } from "../migrator.ts";

export const migration0004: Migration = {
  version: 4,
  name: "catalogs",
  up(db) {
    db.exec(`
      CREATE TABLE catalogs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        format TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0, 1)),
        synced_at INTEGER,
        snapshot TEXT,
        skipped TEXT NOT NULL DEFAULT '[]',
        last_error TEXT
      ) STRICT;
      CREATE TABLE catalog_apps (
        id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
        logical_key TEXT NOT NULL,
        manifest TEXT NOT NULL
      ) STRICT;
      CREATE INDEX catalog_apps_logical_key ON catalog_apps(logical_key);
      CREATE TABLE catalog_assets (
        app_id TEXT PRIMARY KEY REFERENCES catalog_apps(id) ON DELETE CASCADE,
        content BLOB NOT NULL,
        content_type TEXT NOT NULL
      ) STRICT;
      CREATE TABLE installed_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project TEXT NOT NULL UNIQUE,
        provenance TEXT NOT NULL,
        sealed_compose TEXT NOT NULL,
        risk_override INTEGER NOT NULL CHECK(risk_override IN (0, 1)),
        source TEXT NOT NULL,
        last_error TEXT,
        installed_at INTEGER NOT NULL,
        removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0, 1))
      ) STRICT;
      CREATE TABLE app_jobs (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES installed_apps(id),
        action TEXT NOT NULL,
        stage TEXT NOT NULL,
        error TEXT,
        rollback TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
};
