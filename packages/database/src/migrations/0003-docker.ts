import type { Migration } from "../migrator.ts";

/**
 * Compose projects the owner explicitly imported. Ownership of Docker
 * resources is decided only from this table (and, from Phase 5, installed
 * apps), never from container labels. The Compose file paths are the ones
 * validated on the host at import time.
 */
export const migration0003: Migration = {
  version: 3,
  name: "docker",
  up(db) {
    db.exec(`
      CREATE TABLE docker_projects (
        name         TEXT PRIMARY KEY,
        working_dir  TEXT NOT NULL,
        config_files TEXT NOT NULL,
        imported_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        imported_at  INTEGER NOT NULL
      ) STRICT;
    `);
  },
};
