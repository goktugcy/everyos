import type { Migration } from "../migrator.ts";

/**
 * Adds the direct local-model kind. SQLite cannot widen a CHECK constraint in place, so both
 * kind-checked tables are rebuilt. Import records reference conversations with ON DELETE CASCADE,
 * so they are set aside first: dropping the old conversation table must not delete them.
 */
export const migration0012: Migration = {
  version: 12,
  name: "ai-local-models",
  up(db) {
    db.exec(`
      CREATE TABLE ai_agent_configs_next (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('local', 'hermes', 'openclaw')),
        sealed_settings TEXT NOT NULL,
        app_id TEXT REFERENCES installed_apps(id),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, kind)
      ) STRICT;
      INSERT INTO ai_agent_configs_next(user_id, kind, sealed_settings, app_id, updated_at)
        SELECT user_id, kind, sealed_settings, app_id, updated_at FROM ai_agent_configs;
      DROP TABLE ai_agent_configs;
      ALTER TABLE ai_agent_configs_next RENAME TO ai_agent_configs;

      CREATE TEMP TABLE ai_agent_imports_kept AS
        SELECT user_id, kind, source_id, conversation_id FROM ai_agent_imports;
      DROP TABLE ai_agent_imports;
      CREATE TABLE ai_conversations_next (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('local', 'hermes', 'openclaw')),
        sealed_messages TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO ai_conversations_next(id, user_id, kind, sealed_messages, updated_at)
        SELECT id, user_id, kind, sealed_messages, updated_at FROM ai_conversations;
      DROP TABLE ai_conversations;
      ALTER TABLE ai_conversations_next RENAME TO ai_conversations;
      CREATE INDEX ai_conversations_owner ON ai_conversations(user_id, kind, updated_at DESC);
      CREATE TABLE ai_agent_imports (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, kind, source_id)
      ) STRICT;
      INSERT INTO ai_agent_imports(user_id, kind, source_id, conversation_id)
        SELECT user_id, kind, source_id, conversation_id FROM ai_agent_imports_kept;
      DROP TABLE ai_agent_imports_kept;
    `);
  },
};
