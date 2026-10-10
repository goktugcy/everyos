import type { Migration } from "../migrator.ts";

/** Early Phase 5 dev databases recorded v4 before installation tables were added. */
export const migration0005: Migration = {
  version: 5,
  name: "managed-apps",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS installed_apps (
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
      CREATE TABLE IF NOT EXISTS app_jobs (
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
