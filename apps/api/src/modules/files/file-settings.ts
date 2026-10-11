import type { Database } from "@everyos/database";

const KEY = "files";

export interface FileSettings {
  /** Read-only Linux system locations for administrators (off by default). */
  systemRoots: boolean;
}

export function readFileSettings(db: Database): FileSettings {
  const row = db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", KEY);
  try {
    const value = row ? (JSON.parse(row.value) as Partial<FileSettings>) : {};
    return { systemRoots: value.systemRoots === true };
  } catch {
    return { systemRoots: false };
  }
}

export function writeFileSettings(db: Database, settings: FileSettings, now: number): void {
  db.run(
    `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    KEY,
    JSON.stringify(settings),
    now,
  );
}
