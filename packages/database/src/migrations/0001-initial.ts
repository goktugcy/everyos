import type { Migration } from "../migrator.ts";

/**
 * Initial schema: identity, sessions, per-user preferences, instance settings
 * and the audit trail. All timestamps are Unix epoch milliseconds.
 */
export const migration0001: Migration = {
  version: 1,
  name: "initial",
  up(db) {
    db.exec(`
      CREATE TABLE users (
        id                      TEXT PRIMARY KEY,
        username                TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name            TEXT NOT NULL,
        password_hash           TEXT NOT NULL,
        role                    TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        locale                  TEXT NOT NULL DEFAULT 'tr',
        disabled                INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        totp_enabled            INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
        totp_secret_enc         TEXT,
        totp_pending_secret_enc TEXT,
        totp_last_step          INTEGER,
        password_changed_at     INTEGER NOT NULL,
        last_login_at           INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE recovery_codes (
        id         INTEGER PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        used_at    INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, code_hash)
      ) STRICT;

      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        ip           TEXT,
        user_agent   TEXT
      ) STRICT;
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE INDEX sessions_expires_idx ON sessions(expires_at);

      CREATE TABLE user_preferences (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      ) STRICT;

      CREATE TABLE instance_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE audit_events (
        id             INTEGER PRIMARY KEY,
        ts             INTEGER NOT NULL,
        actor_user_id  TEXT,
        actor_username TEXT,
        ip             TEXT,
        action         TEXT NOT NULL,
        target         TEXT,
        outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
        details        TEXT
      ) STRICT;
      CREATE INDEX audit_events_ts_idx ON audit_events(ts);
      CREATE INDEX audit_events_action_idx ON audit_events(action, id);
    `);
  },
};
