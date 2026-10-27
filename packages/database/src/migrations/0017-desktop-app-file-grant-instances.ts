import type { Migration } from "../migrator.ts";

/** Temporary file grants belong to the app window that received them and end with it. */
export const migration0017: Migration = {
  version: 17,
  name: "desktop-app-file-grant-instances",
  up(db) {
    db.exec(`
      ALTER TABLE desktop_app_file_grants ADD COLUMN instance TEXT;
      CREATE INDEX desktop_app_file_grants_instance ON desktop_app_file_grants(instance);
    `);
  },
};
