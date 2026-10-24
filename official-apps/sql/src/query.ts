import { DB_LIMITS, type DbParam, type DbQueryResult, type DbTable } from "@everyos/app-sdk";

export interface Preferences {
  connection: string;
  maxRows: number;
  timeoutMs: number;
}
export function preferences(value: unknown): Preferences {
  const data = value as Partial<Preferences> | null;
  return {
    connection: typeof data?.connection === "string" ? data.connection.slice(0, 200) : "",
    maxRows:
      Number.isInteger(data?.maxRows) && data!.maxRows! >= 1 && data!.maxRows! <= DB_LIMITS.rows.max
        ? data!.maxRows!
        : DB_LIMITS.rows.default,
    timeoutMs:
      Number.isInteger(data?.timeoutMs) &&
      data!.timeoutMs! >= DB_LIMITS.timeoutMs.min &&
      data!.timeoutMs! <= DB_LIMITS.timeoutMs.max
        ? data!.timeoutMs!
        : DB_LIMITS.timeoutMs.default,
  };
}
export function parameters(text: string): DbParam[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (item: unknown) =>
          item === null ||
          typeof item === "boolean" ||
          typeof item === "string" ||
          (typeof item === "number" && Number.isFinite(item)),
      )
      ? (value as DbParam[])
      : null;
  } catch {
    return null;
  }
}
export function selectTable(table: DbTable, engine: "postgres" | "mysql"): string {
  const quote = engine === "mysql" ? "`" : '"';
  const identifier = (text: string) => quote + text.replaceAll(quote, quote + quote) + quote;
  return `SELECT * FROM ${table.schema ? identifier(table.schema) + "." : ""}${identifier(table.name)}`;
}
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return JSON.stringify(value) ?? "";
}
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : cellText(value);
  if (typeof value !== "number" && /^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csv(result: DbQueryResult): string {
  return (
    [
      result.columns.map((column) => csvCell(column.name)).join(","),
      ...result.rows.map((row) => row.map(csvCell).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
