import type { Migration } from "../migrator.ts";

/**
 * The network policy for desktop apps (rules may name one app) and the HTTP monitors EveryOS runs
 * for them. The rules table from 0016 never held data in a release, so it is recreated.
 */
export const migration0018: Migration = {
  version: 18,
  name: "desktop-app-network",
  up(db) {
    db.exec(`
      DROP TABLE desktop_app_network_rules;
      CREATE TABLE desktop_app_network_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('host', 'cidr')),
        pattern TEXT NOT NULL,
        ports TEXT NOT NULL,
        app_id TEXT REFERENCES desktop_app_installations(app_id) ON DELETE CASCADE,
        note TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX desktop_app_network_rules_unique
        ON desktop_app_network_rules(kind, pattern, ports, COALESCE(app_id, ''));

      CREATE TABLE desktop_app_monitors (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES desktop_app_installations(app_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        method TEXT NOT NULL CHECK(method IN ('GET', 'HEAD')),
        interval_seconds INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        expect_min INTEGER NOT NULL,
        expect_max INTEGER NOT NULL,
        keyword TEXT,
        down_after INTEGER NOT NULL,
        verify_tls INTEGER NOT NULL,
        notify INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'up', 'down', 'blocked', 'paused')),
        state_since INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,
        checked_at INTEGER,
        last_status INTEGER,
        last_ms INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX desktop_app_monitors_owner ON desktop_app_monitors(app_id, user_id);

      CREATE TABLE desktop_app_monitor_checks (
        monitor_id TEXT NOT NULL REFERENCES desktop_app_monitors(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        status INTEGER,
        ms INTEGER,
        error TEXT,
        PRIMARY KEY (monitor_id, at)
      ) STRICT, WITHOUT ROWID;
    `);
  },
};
