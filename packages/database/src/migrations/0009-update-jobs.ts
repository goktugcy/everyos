import type { Migration } from "../migrator.ts";

/** History of package list refreshes and upgrades started from the update manager. */
export const migration0009: Migration = {
  version: 9,
  name: "update-jobs",
  up(db) {
    db.exec(`
      CREATE TABLE update_jobs (
        id          TEXT PRIMARY KEY,
        action      TEXT NOT NULL CHECK (action IN ('refresh', 'upgrade')),
        packages    TEXT,
        status      TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
        user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        username    TEXT,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        upgraded    INTEGER,
        error       TEXT,
        output      TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE INDEX update_jobs_started ON update_jobs(started_at DESC);
    `);
  },
};
