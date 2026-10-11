import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@everyos/logger";
import type { Database } from "./database.ts";

export interface Migration {
  /** Strictly increasing, starting at 1. Never renumber a released migration. */
  version: number;
  name: string;
  up: (db: Database) => void;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Raised when the database was migrated by a newer EveryOS release. */
export class DatabaseTooNewError extends MigrationError {
  readonly databaseVersion: number;
  readonly supportedVersion: number;

  constructor(databaseVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${databaseVersion} is newer than this EveryOS release supports (${supportedVersion}). ` +
        "Refusing to start to avoid data loss; upgrade EveryOS or restore a compatible backup.",
    );
    this.name = "DatabaseTooNewError";
    this.databaseVersion = databaseVersion;
    this.supportedVersion = supportedVersion;
  }
}

export interface MigrateOptions {
  /** Directory for automatic pre-migration backups. Omit to skip backups (tests, in-memory DBs). */
  backupDir?: string;
  /** Number of pre-migration backups to keep. */
  keepBackups?: number;
  logger?: Logger;
  now?: () => Date;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
  backupPath: string | null;
}

const BACKUP_PREFIX = "pre-migration-";

function validate(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `Migrations must be numbered consecutively from 1; found version ${migration.version} at position ${index + 1}`,
      );
    }
  });
}

export function currentSchemaVersion(db: Database): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     ) STRICT`,
  );
  return (
    db.get<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_migrations")
      ?.version ?? 0
  );
}

function hasUserTables(db: Database): boolean {
  const row = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
  );
  return (row?.count ?? 0) > 0;
}

function pruneBackups(backupDir: string, keep: number): void {
  let files: string[];
  try {
    files = readdirSync(backupDir).filter(
      (file) => file.startsWith(BACKUP_PREFIX) && file.endsWith(".db"),
    );
  } catch {
    return;
  }
  files.sort();
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, file), { force: true });
  }
}

/**
 * Applies pending migrations, each in its own transaction. Before touching an
 * existing database it takes an online backup so a failed upgrade can be
 * rolled back by restoring that file.
 */
export async function migrate(
  db: Database,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  validate(migrations);
  const latest = migrations.length;
  const from = currentSchemaVersion(db);
  if (from > latest) throw new DatabaseTooNewError(from, latest);

  const pending = migrations.filter((migration) => migration.version > from);
  if (pending.length === 0) return { from, to: from, applied: [], backupPath: null };

  const now = options.now ?? (() => new Date());
  let backupPath: string | null = null;
  if (options.backupDir && (from > 0 || hasUserTables(db))) {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    backupPath = join(options.backupDir, `${BACKUP_PREFIX}v${from}-to-v${latest}-${stamp}.db`);
    options.logger?.info("Backing up database before migration", { backupPath });
    await db.backupTo(backupPath);
    pruneBackups(options.backupDir, options.keepBackups ?? 5);
  }

  const applied: number[] = [];
  for (const migration of pending) {
    options.logger?.info("Applying database migration", {
      version: migration.version,
      name: migration.name,
    });
    try {
      db.transaction(() => {
        migration.up(db);
        db.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          now().getTime(),
        );
      });
    } catch (error) {
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}` +
          (backupPath ? `. A pre-migration backup is available at ${backupPath}` : ""),
      );
    }
    applied.push(migration.version);
  }
  return { from, to: latest, applied, backupPath };
}
