import type { Migration } from "../migrator.ts";

/** Scheduled tasks (predefined actions only) and their run history. */
export const migration0010: Migration = {
  version: 10,
  name: "scheduled-tasks",
  up(db) {
    db.exec(`
      CREATE TABLE scheduled_tasks (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        params      TEXT NOT NULL DEFAULT '{}',
        schedule    TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        notify      TEXT NOT NULL CHECK (notify IN ('failure', 'always', 'never')),
        catch_up    INTEGER NOT NULL DEFAULT 1,
        owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_status TEXT
      ) STRICT;

      CREATE TABLE task_runs (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        trigger     TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'catch-up')),
        status      TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        error       TEXT,
        summary     TEXT
      ) STRICT;
      CREATE INDEX task_runs_task ON task_runs(task_id, started_at DESC);
    `);
  },
};
