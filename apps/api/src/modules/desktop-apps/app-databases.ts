import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import type { DbColumn, DbConnection, DbQueryResult, DbTable } from "@everyos/app-sdk/protocol";
import { DB_LIMITS } from "@everyos/app-sdk/protocol";
import { addressAllowed } from "@everyos/catalogs";
import type { Database } from "@everyos/database";
import type { SecretBox } from "@everyos/security";
import type { DesktopAppDbConnectionView, Permission } from "@everyos/shared";
import type {
  AppDbQueryInputSchema,
  DesktopAppDbConnectionCreateSchema,
  DesktopAppDbConnectionUpdateSchema,
} from "@everyos/shared/schemas";
import mysql, { type Connection as MysqlConnection, type FieldPacket } from "mysql2";
import pg from "pg";
import Cursor from "pg-cursor";
import type { z } from "zod";
import { ApiError, notFound, rateLimited } from "../../http/errors.ts";
import { networkBlocked } from "./app-network.ts";

/*
 * The database connector behind database:connect (docs/app-sdk/databases.md). Administrators
 * connect databases; apps name a connection and never see its credentials. Every statement runs
 * on its own connection, alone (no statement batches), in a read-only transaction unless the
 * connection allows writing and the person confirmed the statement in a dialog the desktop drew.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const PER_MINUTE = 60;
const AT_ONCE = 2;
const MAX_TABLES = 2000;
const passwordContext = (id: string) => `desktop-app-db:${id}`;

type CreateInput = z.output<typeof DesktopAppDbConnectionCreateSchema>;
type UpdateInput = z.output<typeof DesktopAppDbConnectionUpdateSchema>;
type QueryInput = z.output<typeof AppDbQueryInputSchema>;

interface Row {
  id: string;
  name: string;
  engine: "postgres" | "mysql";
  host: string;
  port: number;
  database: string;
  username: string;
  sealed_password: string | null;
  tls: "disable" | "require" | "verify";
  access: "read" | "write";
  audience: "admins" | "everyone";
  app_id: string | null;
  created_at: number;
  updated_at: number;
  creator: string | null;
}

export const dbFailed = (error: unknown) => {
  const { code, message, position } = error as {
    code?: string;
    message?: string;
    position?: string;
  };
  return new ApiError(502, "DESKTOP_APP_DB_FAILED", "The database operation failed", {
    details: {
      code: typeof code === "string" ? code : "error",
      message: String(message ?? "").slice(0, 500),
      ...(position ? { position: Number(position) } : {}),
    },
  });
};

const readOnly = () =>
  new ApiError(403, "DESKTOP_APP_DB_READ_ONLY", "This connection only reads", {
    details: {},
  });

/** PostgreSQL type OIDs by name (the common ones; others show their number). */
const PG_TYPES: Record<number, string> = {
  16: "bool",
  17: "bytea",
  18: "char",
  19: "name",
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  26: "oid",
  114: "json",
  142: "xml",
  650: "cidr",
  700: "float4",
  701: "float8",
  790: "money",
  829: "macaddr",
  869: "inet",
  1000: "bool[]",
  1005: "int2[]",
  1007: "int4[]",
  1009: "text[]",
  1016: "int8[]",
  1042: "bpchar",
  1043: "varchar",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1186: "interval",
  1266: "timetz",
  1560: "bit",
  1562: "varbit",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
  3807: "jsonb[]",
};
/** MySQL column type ids by name (mysql2 maps ids to names). */
const MYSQL_TYPES = Object.fromEntries(
  Object.entries(mysql.Types as unknown as Record<string, unknown>)
    .filter(([id, name]) => /^\d+$/.test(id) && typeof name === "string")
    .map(([id, name]) => [Number(id), String(name).toLowerCase()]),
) as Record<number, string>;

/** Dates and times stay as PostgreSQL writes them (no shift into the server's time zone). */
const PG_TEXT_TYPES = new Set([1082, 1083, 1114, 1184, 1186, 1266]);
const asText = (value: string) => value;
const pgTypes = {
  getTypeParser: (oid: number, format?: "text" | "binary"): ((value: string) => unknown) =>
    PG_TEXT_TYPES.has(oid)
      ? asText
      : (pg.types.getTypeParser(oid, format ?? "text") as (value: string) => unknown),
};

/** A cell as JSON: dates as ISO text, binary as `\x` hex, long text cut. */
function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string")
    return value.length > DB_LIMITS.cellChars ? `${value.slice(0, DB_LIMITS.cellChars)}…` : value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, DB_LIMITS.cellChars / 2).toString("hex");
    return `\\x${hex}${value.length > DB_LIMITS.cellChars / 2 ? "…" : ""}`;
  }
  if (Array.isArray(value)) return value.map(cell);
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > DB_LIMITS.cellChars ? `${text.slice(0, DB_LIMITS.cellChars)}…` : value;
  }
  return value;
}

/** Rows within the size budget of a result. */
function bounded(rows: unknown[][], maxRows: number): { rows: unknown[][]; truncated: boolean } {
  const kept: unknown[][] = [];
  let size = 0;
  for (const row of rows.slice(0, maxRows)) {
    const values = row.map(cell);
    size += JSON.stringify(values).length;
    if (size > DB_LIMITS.resultBytes) return { rows: kept, truncated: true };
    kept.push(values);
  }
  return { rows: kept, truncated: rows.length > maxRows };
}

/** The statement's first word (`SELECT`, `UPDATE`, …), as MySQL does not say. */
const commandOf = (sql: string) =>
  /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? null;

interface Target {
  address: string;
  servername: string | undefined;
}

/**
 * Databases administrators connect for desktop apps, and the statements apps run on them.
 */
export class AppDatabases {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #now: () => number;
  readonly #recent = new Map<string, number[]>();
  readonly #active = new Map<string, number>();

  constructor(options: { db: Database; secrets: SecretBox; now: () => number }) {
    this.#db = options.db;
    this.#secrets = options.secrets;
    this.#now = options.now;
  }

  /* ---------------------------------------------------------------- administration */

  #rows(where = "", ...values: Array<string | null>): Row[] {
    return this.#db.all<Row>(
      `SELECT c.*, u.username AS creator FROM desktop_app_db_connections c
       LEFT JOIN users u ON u.id = c.created_by ${where} ORDER BY c.name`,
      ...values,
    );
  }

  #view(row: Row): DesktopAppDbConnectionView {
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      hasPassword: row.sealed_password !== null,
      tls: row.tls,
      access: row.access,
      audience: row.audience,
      appId: row.app_id,
      createdBy: row.creator,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(appId?: string): DesktopAppDbConnectionView[] {
    return (
      appId === undefined
        ? this.#rows()
        : this.#rows("WHERE c.app_id IS NULL OR c.app_id = ?", appId)
    ).map((row) => this.#view(row));
  }

  #row(id: string): Row {
    const [row] = this.#rows("WHERE c.id = ?", id);
    if (!row) throw notFound("Connection");
    return row;
  }

  #checkApp(appId: string | null): void {
    if (appId && !this.#db.get("SELECT 1 FROM desktop_app_installations WHERE app_id = ?", appId))
      throw notFound("App");
  }

  create(input: CreateInput, userId: string): DesktopAppDbConnectionView {
    this.#checkApp(input.appId);
    const id = randomUUID();
    const now = this.#now();
    this.#unique(() =>
      this.#db.run(
        `INSERT INTO desktop_app_db_connections(id, name, engine, host, port, database, username,
           sealed_password, tls, access, audience, app_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.engine,
        input.host,
        input.port,
        input.database,
        input.username,
        input.password ? this.#secrets.seal(input.password, passwordContext(id)) : null,
        input.tls,
        input.access,
        input.audience,
        input.appId,
        userId,
        now,
        now,
      ),
    );
    return this.#view(this.#row(id));
  }

  update(id: string, input: UpdateInput): DesktopAppDbConnectionView {
    const row = this.#row(id);
    this.#checkApp(input.appId);
    const sealed =
      input.password === undefined
        ? row.sealed_password
        : input.password
          ? this.#secrets.seal(input.password, passwordContext(id))
          : null;
    this.#unique(() =>
      this.#db.run(
        `UPDATE desktop_app_db_connections SET name = ?, engine = ?, host = ?, port = ?, database = ?,
           username = ?, sealed_password = ?, tls = ?, access = ?, audience = ?, app_id = ?,
           updated_at = ?
         WHERE id = ?`,
        input.name,
        input.engine,
        input.host,
        input.port,
        input.database,
        input.username,
        sealed,
        input.tls,
        input.access,
        input.audience,
        input.appId,
        this.#now(),
        id,
      ),
    );
    return this.#view(this.#row(id));
  }

  #unique(run: () => unknown): void {
    try {
      run();
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new ApiError(409, "CONFLICT", "A connection with this name already exists");
      throw error;
    }
  }

  remove(id: string): boolean {
    return this.#db.run("DELETE FROM desktop_app_db_connections WHERE id = ?", id).changes > 0;
  }

  /** Connects and asks the version: for administrators setting a connection up. */
  async testById(id: string): Promise<{ version: string; ms: number }> {
    return this.#test(this.#row(id));
  }

  /* ---------------------------------------------------------------- apps */

  /** The connections an app may use for this person. */
  usable(appId: string, permissions: ReadonlySet<Permission>): DbConnection[] {
    return this.#usableRows(appId, permissions).map((row) => ({
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      access: row.access,
    }));
  }

  #usableRows(appId: string, permissions: ReadonlySet<Permission>): Row[] {
    return this.#rows("WHERE c.app_id IS NULL OR c.app_id = ?", appId).filter(
      (row) => row.audience === "everyone" || permissions.has("settings:manage"),
    );
  }

  #usable(appId: string, permissions: ReadonlySet<Permission>, id: string): Row {
    const row = this.#usableRows(appId, permissions).find((entry) => entry.id === id);
    if (!row) throw notFound("Connection");
    return row;
  }

  async test(
    appId: string,
    user: { id: string; permissions: ReadonlySet<Permission> },
    id: string,
  ) {
    const row = this.#usable(appId, user.permissions, id);
    const end = this.#begin(appId, user.id);
    try {
      return await this.#test(row);
    } finally {
      end();
    }
  }

  async tables(
    appId: string,
    user: { id: string; permissions: ReadonlySet<Permission> },
    id: string,
  ): Promise<{ tables: DbTable[]; truncated: boolean }> {
    const row = this.#usable(appId, user.permissions, id);
    const end = this.#begin(appId, user.id);
    try {
      const sql =
        row.engine === "postgres"
          ? `SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
             WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY c.table_schema, c.table_name, c.ordinal_position LIMIT 50000`
          : `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE
             FROM information_schema.COLUMNS c
             JOIN information_schema.TABLES t
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
             WHERE c.TABLE_SCHEMA = DATABASE()
             ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION LIMIT 50000`;
      const result = await this.#run(
        row,
        { sql, params: [], maxRows: 50_000, timeoutMs: 30_000 },
        false,
      );
      const tables = new Map<string, DbTable>();
      for (const [schema, name, type, column, columnType, nullable] of result.rows as string[][]) {
        const key = `${schema}\u0000${name}`;
        let table = tables.get(key);
        if (!table) {
          if (tables.size >= MAX_TABLES) return { tables: [...tables.values()], truncated: true };
          table = {
            schema: row.engine === "postgres" ? (schema ?? null) : null,
            name: name ?? "",
            kind: type === "VIEW" ? "view" : "table",
            columns: [],
          };
          tables.set(key, table);
        }
        const entry: DbColumn = {
          name: column ?? "",
          type: columnType ?? "",
          nullable: nullable === "YES",
        };
        table.columns.push(entry);
      }
      return { tables: [...tables.values()], truncated: result.truncated };
    } finally {
      end();
    }
  }

  /**
   * One statement for an app. `confirmed` is set by the desktop only after the person confirmed a
   * write in a dialog it drew; the app cannot set it.
   */
  async query(
    appId: string,
    user: { id: string; permissions: ReadonlySet<Permission> },
    input: QueryInput,
    confirmed: boolean,
  ): Promise<DbQueryResult> {
    const row = this.#usable(appId, user.permissions, input.connection);
    if (input.write && (row.access !== "write" || !confirmed)) {
      if (row.access !== "write") throw readOnly();
      throw new ApiError(403, "FORBIDDEN", "Changing data needs the person's confirmation", {
        details: { confirmation: "required" },
      });
    }
    const end = this.#begin(appId, user.id);
    try {
      return await this.#run(row, input, input.write);
    } finally {
      end();
    }
  }

  /** The SHA-256 of a statement (audits record it, not the statement). */
  static fingerprint(sql: string): string {
    return createHash("sha256").update(sql).digest("hex");
  }

  /* ---------------------------------------------------------------- budget */

  #begin(appId: string, userId: string): () => void {
    const now = this.#now();
    const key = `${appId}:${userId}`;
    const recent = (this.#recent.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PER_MINUTE) throw rateLimited(60_000 - (now - recent[0]!));
    const active = this.#active.get(userId) ?? 0;
    if (active >= AT_ONCE) throw rateLimited(1000);
    recent.push(now);
    this.#recent.set(key, recent);
    this.#active.set(userId, active + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.#active.get(userId) ?? 1) - 1;
      if (left > 0) this.#active.set(userId, left);
      else this.#active.delete(userId);
    };
  }

  /* ---------------------------------------------------------------- engines */

  /** The checked address to connect to: never link-local (cloud metadata) or unspecified. */
  async #target(row: Row): Promise<Target> {
    let addresses: Array<{ address: string }>;
    if (isIP(row.host)) addresses = [{ address: row.host }];
    else {
      try {
        addresses = await lookup(row.host, { all: true, verbatim: true });
      } catch (error) {
        throw dbFailed(error);
      }
    }
    if (!addresses.length || addresses.some(({ address }) => !addressAllowed(address, true)))
      throw networkBlocked(row.host, row.port, "address");
    return {
      address: addresses[0]!.address,
      servername: isIP(row.host) ? undefined : row.host,
    };
  }

  #password(row: Row): string {
    return row.sealed_password
      ? this.#secrets.open(row.sealed_password, passwordContext(row.id))
      : "";
  }

  async #test(row: Row): Promise<{ version: string; ms: number }> {
    const started = performance.now();
    const result = await this.#run(
      row,
      {
        sql: row.engine === "postgres" ? "SELECT version()" : "SELECT VERSION()",
        params: [],
        maxRows: 1,
        timeoutMs: 15_000,
      },
      false,
    );
    return {
      version: typeof result.rows[0]?.[0] === "string" ? result.rows[0][0] : "",
      ms: Math.round(performance.now() - started),
    };
  }

  async #run(
    row: Row,
    input: { sql: string; params: QueryInput["params"]; maxRows: number; timeoutMs: number },
    write: boolean,
  ): Promise<DbQueryResult> {
    const target = await this.#target(row);
    return row.engine === "postgres"
      ? this.#postgres(row, target, input, write)
      : this.#mysql(row, target, input, write);
  }

  async #postgres(
    row: Row,
    target: Target,
    input: { sql: string; params: QueryInput["params"]; maxRows: number; timeoutMs: number },
    write: boolean,
  ): Promise<DbQueryResult> {
    const client = new pg.Client({
      host: target.address,
      port: row.port,
      user: row.username,
      password: this.#password(row),
      database: row.database,
      ssl:
        row.tls === "disable"
          ? false
          : {
              rejectUnauthorized: row.tls === "verify",
              ...(target.servername ? { servername: target.servername } : {}),
            },
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      application_name: "EveryOS",
      // A stuck server cannot hold the request past the timeout.
      query_timeout: input.timeoutMs + 5000,
    });
    client.on("error", () => undefined);
    const started = performance.now();
    try {
      await client.connect();
      await client.query(write ? "BEGIN" : "BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(input.timeoutMs)}`);
      // Fixes the transaction's mode: a later SET TRANSACTION READ WRITE is refused.
      await client.query("SELECT 1");
      // A cursor runs exactly one statement (extended protocol) and lets us stop after maxRows.
      const cursor = client.query(
        new Cursor(input.sql, input.params, { rowMode: "array", types: pgTypes }),
      );
      const { rows, result } = await new Promise<{
        rows: unknown[][];
        result: { fields: pg.FieldDef[]; command: string | null; rowCount: number | null };
      }>((resolve, reject) =>
        cursor.read(input.maxRows + 1, (error, rows, result) =>
          error ? reject(error) : resolve({ rows, result }),
        ),
      );
      await cursor.close();
      await client.query(write ? "COMMIT" : "ROLLBACK");
      const { rows: kept, truncated } = bounded(rows, input.maxRows);
      return {
        command: result.command ?? null,
        columns: result.fields.map((field) => ({
          name: field.name,
          type: PG_TYPES[field.dataTypeID] ?? `oid ${field.dataTypeID}`,
        })),
        rows: kept,
        rowCount: truncated ? null : (result.rowCount ?? kept.length),
        truncated,
        ms: Math.round(performance.now() - started),
        readOnly: !write,
      };
    } catch (error) {
      if (!write && (error as { code?: string }).code === "25006") throw readOnly();
      if (error instanceof ApiError) throw error;
      throw dbFailed(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async #mysql(
    row: Row,
    target: Target,
    input: { sql: string; params: QueryInput["params"]; maxRows: number; timeoutMs: number },
    write: boolean,
  ): Promise<DbQueryResult> {
    const connection: MysqlConnection = mysql.createConnection({
      host: target.address,
      port: row.port,
      user: row.username,
      password: this.#password(row),
      database: row.database,
      connectTimeout: CONNECT_TIMEOUT_MS,
      ...(row.tls === "disable"
        ? {}
        : {
            ssl: {
              rejectUnauthorized: row.tls === "verify",
              ...(target.servername ? { servername: target.servername } : {}),
            },
          }),
      // One statement per call, and a server can never ask for a local file.
      multipleStatements: false,
      flags: ["-LOCAL_FILES", "-MULTI_STATEMENTS"],
      rowsAsArray: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
    });
    connection.on("error", () => undefined);
    const run = (sql: string) =>
      new Promise<void>((resolve, reject) =>
        connection.query(sql, (error) => (error ? reject(error) : resolve())),
      );
    const started = performance.now();
    let timer: NodeJS.Timeout | null = null;
    try {
      await new Promise<void>((resolve, reject) =>
        connection.connect((error) => (error ? reject(error) : resolve())),
      );
      const mariadb = /mariadb/i.test(
        (connection as unknown as { serverVersion?: string }).serverVersion ?? "",
      );
      // The session stays read-only for every statement, including DDL's own transaction.
      await run(`SET SESSION TRANSACTION ${write ? "READ WRITE" : "READ ONLY"}`);
      await run(
        mariadb
          ? `SET SESSION max_statement_time = ${(input.timeoutMs / 1000).toFixed(3)}`
          : `SET SESSION max_execution_time = ${Math.trunc(input.timeoutMs)}`,
      ).catch(() => undefined);
      await run(write ? "START TRANSACTION" : "START TRANSACTION READ ONLY");
      const outcome = await new Promise<{
        rows: unknown[][];
        fields: FieldPacket[];
        rowCount: number | null;
        command: string | null;
        stopped: boolean;
      }>((resolve, reject) => {
        const rows: unknown[][] = [];
        let fields: FieldPacket[] = [];
        let rowCount: number | null = null;
        let stopped = false;
        timer = setTimeout(() => {
          connection.destroy();
          reject(Object.assign(new Error("The statement took too long"), { code: "ETIMEDOUT" }));
        }, input.timeoutMs + 2000);
        const query = connection.query({ sql: input.sql, values: input.params, rowsAsArray: true });
        query.on("fields", (list: FieldPacket[]) => {
          fields = list;
        });
        query.on("result", (result: unknown) => {
          if (Array.isArray(result)) {
            if (stopped) return;
            rows.push(result);
            if (rows.length > input.maxRows) {
              // Enough: stop reading; the connection is closed below.
              stopped = true;
              connection.pause();
              resolve({ rows, fields, rowCount: null, command: commandOf(input.sql), stopped });
            }
          } else rowCount = (result as { affectedRows?: number }).affectedRows ?? null;
        });
        query.on("error", reject);
        query.on("end", () =>
          resolve({
            rows,
            fields,
            rowCount: fields.length ? rows.length : rowCount,
            command: commandOf(input.sql),
            stopped,
          }),
        );
      });
      if (outcome.stopped) connection.destroy();
      else await run(write ? "COMMIT" : "ROLLBACK");
      const { rows: kept, truncated } = bounded(outcome.rows, input.maxRows);
      return {
        command: outcome.command,
        columns: outcome.fields.map((field) => ({
          name: field.name,
          type: MYSQL_TYPES[field.columnType ?? field.type ?? -1] ?? "unknown",
        })),
        rows: kept,
        rowCount: truncated ? null : outcome.rowCount,
        truncated,
        ms: Math.round(performance.now() - started),
        readOnly: !write,
      };
    } catch (error) {
      const { code, errno } = error as { code?: string; errno?: number };
      if (!write && (errno === 1792 || code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION"))
        throw readOnly();
      if (error instanceof ApiError) throw error;
      throw dbFailed(error);
    } finally {
      if (timer) clearTimeout(timer);
      connection.destroy();
    }
  }
}
