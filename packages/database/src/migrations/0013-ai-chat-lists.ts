import type { Migration } from "../migrator.ts";

/** Favorite and archived chats; the two are kept exclusive by the API. */
export const migration0013: Migration = {
  version: 13,
  name: "ai-chat-lists",
  up(db) {
    db.exec(`
      ALTER TABLE ai_conversations ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1));
      ALTER TABLE ai_conversations ADD COLUMN archived_at INTEGER;
    `);
  },
};
