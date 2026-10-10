import type { Migration } from "../migrator.ts";

/**
 * Application integrations used by widgets. Credentials are sealed with the
 * secret box (`secret`) and never leave the API; `audience` decides who may
 * read the integration's data.
 */
export const migration0007: Migration = {
  version: 7,
  name: "integrations",
  up(db) {
    db.exec(`
      CREATE TABLE integrations (
        id         TEXT PRIMARY KEY,
        adapter    TEXT NOT NULL,
        name       TEXT NOT NULL,
        app_id     TEXT,
        base_url   TEXT,
        audience   TEXT NOT NULL CHECK (audience IN ('managers', 'everyone')),
        username   TEXT,
        secret     TEXT,
        options    TEXT NOT NULL DEFAULT '{}',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
};
