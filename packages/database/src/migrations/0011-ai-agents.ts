import type { Migration } from "../migrator.ts";

/** Agent credentials and chat transcripts are context-bound SecretBox ciphertext. */
export const migration0011: Migration = {
  version: 11,
  name: "ai-agents",
  up(db) {
    db.exec(`
      CREATE TABLE ai_agent_configs (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('hermes', 'openclaw')),
        sealed_settings TEXT NOT NULL,
        app_id TEXT REFERENCES installed_apps(id),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, kind)
      ) STRICT;
      CREATE TABLE ai_conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('hermes', 'openclaw')),
        sealed_messages TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX ai_conversations_owner ON ai_conversations(user_id, kind, updated_at DESC);
      CREATE TABLE ai_agent_imports (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, kind, source_id)
      ) STRICT;
    `);
  },
};
