/*
 * JSON parsing with exact error positions, formatting, paths, and conversion to CSV. JSON.parse
 * does the work when the text is valid; when it is not, a strict scanner (RFC 8259) finds where
 * and why, so the editor can point at the first problem.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ParseProblem =
  | "unexpected-end"
  | "unexpected-character"
  | "bad-string"
  | "bad-escape"
  | "bad-number"
  | "trailing-comma"
  | "expected-colon"
  | "expected-comma"
  | "expected-key"
  | "trailing-content"
  | "empty";

export interface ParseError {
  problem: ParseProblem;
  offset: number;
  line: number;
  column: number;
}

export type ParseResult = { ok: true; value: Json } | { ok: false; error: ParseError };

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let index = 0; index < offset && index < text.length; index += 1)
    if (text.charCodeAt(index) === 10) {
      line += 1;
      start = index + 1;
    }
  return { line, column: offset - start + 1 };
}

class Problem extends Error {
  readonly problem: ParseProblem;
  readonly offset: number;

  constructor(problem: ParseProblem, offset: number) {
    super(problem);
    this.problem = problem;
    this.offset = offset;
  }
}

/** Finds the first syntax error of a text JSON.parse refused. */
function locate(text: string): Problem {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i += 1;
  };
  const fail = (problem: ParseProblem, at = i): never => {
    throw new Problem(problem, at);
  };
  const value = (): void => {
    ws();
    if (i >= text.length) fail("unexpected-end");
    const char = text[i]!;
    if (char === "{") return object();
    if (char === "[") return array();
    if (char === '"') return string();
    if (char === "-" || (char >= "0" && char <= "9")) return number();
    for (const word of ["true", "false", "null"])
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    fail("unexpected-character");
  };
  const string = () => {
    i += 1;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (text[i] === '"') {
        i += 1;
        return;
      }
      if (code < 0x20) fail("bad-string");
      if (text[i] === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("bad-escape", i);
          i += 6;
          continue;
        }
        if (!next || !'"\\/bfnrt'.includes(next)) fail("bad-escape", i);
        i += 2;
        continue;
      }
      i += 1;
    }
    fail("unexpected-end");
  };
  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail("bad-number");
    i += match![0].length;
  };
  const array = () => {
    i += 1;
    ws();
    if (text[i] === "]") {
      i += 1;
      return;
    }
    for (;;) {
      value();
      ws();
      if (text[i] === ",") {
        i += 1;
        ws();
        if (text[i] === "]") fail("trailing-comma");
        continue;
      }
      if (text[i] === "]") {
        i += 1;
        return;
      }
      fail(i >= text.length ? "unexpected-end" : "expected-comma");
    }
  };
  const object = () => {
    i += 1;
    ws();
    if (text[i] === "}") {
      i += 1;
      return;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') fail(i >= text.length ? "unexpected-end" : "expected-key");
      string();
      ws();
      if (text[i] !== ":") fail(i >= text.length ? "unexpected-end" : "expected-colon");
      i += 1;
      value();
      ws();
      if (text[i] === ",") {
        i += 1;
        ws();
        if (text[i] === "}") fail("trailing-comma");
        continue;
      }
      if (text[i] === "}") {
        i += 1;
        return;
      }
      fail(i >= text.length ? "unexpected-end" : "expected-comma");
    }
  };
  try {
    ws();
    if (i >= text.length) return new Problem("empty", 0);
    value();
    ws();
    if (i < text.length) return new Problem("trailing-content", i);
    // JSON.parse refused something the scanner accepts (should not happen): point at the start.
    return new Problem("unexpected-character", 0);
  } catch (error) {
    if (error instanceof Problem) return error;
    throw error;
  }
}

export function parseJson(text: string): ParseResult {
  try {
    if (!text.trim()) throw new SyntaxError("empty");
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    const problem = locate(text);
    return {
      ok: false,
      error: {
        problem: problem.problem,
        offset: problem.offset,
        ...position(text, problem.offset),
      },
    };
  }
}

export type Indent = 2 | 4 | "tab";

function sortValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => [key, sortValue(value[key]!)]),
    );
  return value;
}

export function formatJson(value: Json, indent: Indent, sortKeys = false): string {
  return JSON.stringify(
    sortKeys ? sortValue(value) : value,
    null,
    indent === "tab" ? "\t" : indent,
  );
}

export function minifyJson(value: Json): string {
  return JSON.stringify(value);
}

export type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

export function typeOf(value: Json): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "object" | "string" | "number" | "boolean";
}

export type PathSegment = string | number;

/** `$.store.books[0]['odd key']` */
export function pathString(path: readonly PathSegment[]): string {
  return (
    "$" +
    path
      .map((segment) =>
        typeof segment === "number"
          ? `[${segment}]`
          : /^[A-Za-z_$][\w$]*$/.test(segment)
            ? `.${segment}`
            : `[${JSON.stringify(segment).replace(/^"|"$/g, "'")}]`,
      )
      .join("")
  );
}

/* ------------------------------------------------------------------ CSV */

/** Whether a value converts to a table: an array of objects (or of plain values). */
export function isTabular(value: Json): value is Json[] {
  return Array.isArray(value) && value.length > 0;
}

function flatten(value: Json, prefix: string, out: Record<string, Json>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length && prefix) out[prefix] = {};
    for (const key of keys) flatten(value[key]!, prefix ? `${prefix}.${key}` : key, out);
  } else out[prefix || "value"] = value;
}

function csvCell(value: Json | undefined): string {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV: the union of the rows' keys (nested objects as dot paths, arrays as JSON). */
export function toCsv(rows: readonly Json[]): {
  csv: string;
  columns: string[];
  records: Array<Record<string, Json>>;
} {
  const records = rows.map((row) => {
    const flat: Record<string, Json> = {};
    flatten(row, "", flat);
    return flat;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of records)
    for (const key of Object.keys(record))
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
  const lines = [columns.map((column) => csvCell(column)).join(",")];
  for (const record of records)
    lines.push(columns.map((column) => csvCell(record[column])).join(","));
  return { csv: `${lines.join("\r\n")}\r\n`, columns, records };
}
