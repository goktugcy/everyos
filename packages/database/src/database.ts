import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqlParam = SQLInputValue;
export type SqlParams = SqlParam[] | [Record<string, SqlParam>];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface OpenDatabaseOptions {
  readOnly?: boolean;
  /** Milliseconds to wait for a lock held by another connection. */
  busyTimeoutMs?: number;
}

export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionError";
  }
}

/**
 * Thin, synchronous wrapper around `node:sqlite`.
 *
 * All SQLite access in Otuken goes through this class so the underlying
 * driver can be swapped (e.g. for better-sqlite3) without touching callers.
 * Transactions are synchronous on purpose: an async callback could interleave
 * with other requests while the write lock is held.
 */
export class Database {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #transactionDepth = 0;

  constructor(path: string, options: OpenDatabaseOptions = {}) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.#db = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
      timeout: options.busyTimeoutMs ?? 5000,
    });
    if (path !== ":memory:" && !options.readOnly) {
      // WAL gives concurrent readers during writes; NORMAL is durable across
      // application crashes and only risks the last transaction on power loss.
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA synchronous = NORMAL");
    }
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA temp_store = MEMORY");
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }

  prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  get<T>(sql: string, ...params: SqlParams): T | undefined {
    return this.prepare(sql).get(...(params as SqlParam[])) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParams): T[] {
    return this.prepare(sql).all(...(params as SqlParam[])) as T[];
  }

  run(sql: string, ...params: SqlParams): RunResult {
    const result = this.prepare(sql).run(...(params as SqlParam[]));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /**
   * Runs `fn` inside a transaction. Nested calls use savepoints, so a failing
   * inner block can be rolled back without aborting the outer transaction.
   */
  transaction<T>(fn: () => T, mode: "deferred" | "immediate" = "immediate"): T {
    const depth = this.#transactionDepth;
    const savepoint = `otuken_sp_${depth}`;
    this.#db.exec(depth === 0 ? `BEGIN ${mode.toUpperCase()}` : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth++;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new TransactionError("Transaction callbacks must be synchronous");
      }
      this.#transactionDepth--;
      this.#db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#transactionDepth = depth;
      if (depth === 0) {
        this.#db.exec("ROLLBACK");
      } else {
        this.#db.exec(`ROLLBACK TO ${savepoint}`);
        this.#db.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    }
  }

  /** Online, consistent copy of the database (SQLite backup API). */
  async backupTo(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
    await backup(this.#db, destination);
  }

  /** Returns true when `PRAGMA quick_check` reports no corruption. */
  quickCheck(): boolean {
    const row = this.get<{ quick_check: string }>("PRAGMA quick_check");
    return row?.quick_check === "ok";
  }

  close(): void {
    this.#statements.clear();
    if (this.#db.isOpen) this.#db.close();
  }
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  return new Database(path, options);
}
