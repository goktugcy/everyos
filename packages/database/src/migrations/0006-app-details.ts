import type { Migration } from "../migrator.ts";
export const migration0006: Migration = {
  version: 6,
  name: "app-details",
  up(db) {
    db.exec(`ALTER TABLE installed_apps ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE catalog_media (
        app_id TEXT NOT NULL REFERENCES catalog_apps(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        content BLOB NOT NULL,
        content_type TEXT NOT NULL,
        PRIMARY KEY(app_id, position)
      ) STRICT;`);
  },
};
