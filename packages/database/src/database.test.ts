import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentSchemaVersion,
  DatabaseTooNewError,
  migrate,
  MigrationError,
  openDatabase,
  OTUKEN_MIGRATIONS,
  TransactionError,
  type Database,
  type Migration,
} from "./index.ts";

const opened: Database[] = [];
function tempDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "otuken-db-"));
  const db = openDatabase(join(dir, "otuken.db"));
  opened.push(db);
  return { db, dir };
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

const testMigrations: Migration[] = [
  {
    version: 1,
    name: "one",
    up: (db) => db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT) STRICT"),
  },
  { version: 2, name: "two", up: (db) => db.exec("ALTER TABLE a ADD COLUMN w TEXT") },
];

describe("Database", () => {
  it("enables WAL and foreign keys", () => {
    const { db } = tempDb();
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  });

  it("commits and rolls back transactions, including nested savepoints", () => {
    const { db } = tempDb();
    db.exec("CREATE TABLE t (v INTEGER) STRICT");
    db.transaction(() => db.run("INSERT INTO t VALUES (?)", 1));
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (?)", 2);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (?)", 3);
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t VALUES (?)", 4);
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(db.all<{ v: number }>("SELECT v FROM t ORDER BY v").map((r) => r.v)).toEqual([1, 3]);
    expect(db.inTransaction).toBe(false);
  });

  it("refuses async transaction callbacks", () => {
    const { db } = tempDb();
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow(TransactionError);
    expect(db.inTransaction).toBe(false);
  });

  it("supports named parameters", () => {
    const { db } = tempDb();
    db.exec("CREATE TABLE n (id INTEGER, name TEXT) STRICT");
    db.run("INSERT INTO n VALUES (:id, :name)", { id: 7, name: "otuken" });
    expect(db.get<{ name: string }>("SELECT name FROM n WHERE id = :id", { id: 7 })?.name).toBe(
      "otuken",
    );
  });

  it("passes the integrity quick check", () => {
    expect(tempDb().db.quickCheck()).toBe(true);
  });
});

describe("migrate", () => {
  it("applies all migrations to a fresh database without a backup", async () => {
    const { db, dir } = tempDb();
    const result = await migrate(db, testMigrations, { backupDir: join(dir, "backups") });
    expect(result).toEqual({ from: 0, to: 2, applied: [1, 2], backupPath: null });
    expect(currentSchemaVersion(db)).toBe(2);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("is idempotent", async () => {
    const { db } = tempDb();
    await migrate(db, testMigrations);
    expect((await migrate(db, testMigrations)).applied).toEqual([]);
  });

  it("backs up an existing database before applying new migrations", async () => {
    const { db, dir } = tempDb();
    await migrate(db, testMigrations.slice(0, 1));
    db.run("INSERT INTO a (v) VALUES (?)", "keep-me");
    const backupDir = join(dir, "backups");
    const result = await migrate(db, testMigrations, { backupDir });
    expect(result.applied).toEqual([2]);
    expect(result.backupPath).not.toBeNull();
    const backup = openDatabase(result.backupPath!, { readOnly: true });
    opened.push(backup);
    expect(backup.get<{ v: string }>("SELECT v FROM a")?.v).toBe("keep-me");
    expect(currentSchemaVersion(db)).toBe(2);
  });

  it("keeps only the configured number of backups", async () => {
    const { db, dir } = tempDb();
    const backupDir = join(dir, "backups");
    await migrate(db, testMigrations.slice(0, 1));
    let tick = 0;
    for (let i = 2; i <= 5; i++) {
      const migrations: Migration[] = [
        ...testMigrations.slice(0, 1),
        ...Array.from({ length: i - 1 }, (_, k) => ({
          version: k + 2,
          name: `m${k + 2}`,
          up: (d: Database) =>
            d.exec(`CREATE TABLE IF NOT EXISTS extra_${k + 2} (x INTEGER) STRICT`),
        })),
      ];
      await migrate(db, migrations, {
        backupDir,
        keepBackups: 2,
        now: () => new Date(1_000_000 + tick++ * 1000),
      });
    }
    expect(readdirSync(backupDir)).toHaveLength(2);
  });

  it("rolls back a failing migration and reports the backup", async () => {
    const { db, dir } = tempDb();
    await migrate(db, testMigrations.slice(0, 1));
    const broken: Migration[] = [
      ...testMigrations.slice(0, 1),
      {
        version: 2,
        name: "broken",
        up: (d) => {
          d.exec("CREATE TABLE partial (x INTEGER) STRICT");
          d.exec("THIS IS NOT SQL");
        },
      },
    ];
    await expect(migrate(db, broken, { backupDir: join(dir, "b") })).rejects.toThrow(
      /pre-migration backup/,
    );
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.get("SELECT name FROM sqlite_schema WHERE name = 'partial'")).toBeUndefined();
  });

  it("refuses to run against a database from a newer release", async () => {
    const { db } = tempDb();
    await migrate(db, testMigrations);
    await expect(migrate(db, testMigrations.slice(0, 1))).rejects.toBeInstanceOf(
      DatabaseTooNewError,
    );
  });

  it("rejects non-consecutive migration numbering", async () => {
    const { db } = tempDb();
    await expect(
      migrate(db, [{ version: 2, name: "gap", up: () => undefined }]),
    ).rejects.toBeInstanceOf(MigrationError);
  });

  it("applies the real Otuken schema", async () => {
    const { db } = tempDb();
    const result = await migrate(db, OTUKEN_MIGRATIONS);
    expect(result.to).toBe(OTUKEN_MIGRATIONS.length);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "recovery_codes",
        "user_preferences",
        "instance_settings",
        "audit_events",
      ]),
    );
  });
});
