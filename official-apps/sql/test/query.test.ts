import { describe, expect, it } from "vitest";
import { cellText, csv, parameters, preferences, selectTable } from "../src/query.ts";

import { result, table } from "./fixture.ts";
describe("SQL query data", () => {
  it("restores only bounded non-secret preferences", () => {
    expect(preferences(null)).toEqual({ connection: "", maxRows: 500, timeoutMs: 30000 });
    expect(
      preferences({ connection: "id", maxRows: 1001, timeoutMs: -1, password: "discard" }),
    ).toEqual({ connection: "id", maxRows: 500, timeoutMs: 30000 });
    expect(
      preferences({ connection: "x".repeat(300), maxRows: 1000, timeoutMs: 120000 }).connection,
    ).toHaveLength(200);
  });
  it("accepts only a bounded array of JSON scalar parameters", () => {
    expect(parameters('["name", 2, true, null]')).toEqual(["name", 2, true, null]);
    for (const input of [
      "{}",
      "[[1]]",
      '[{"name":1}]',
      "[1e999]",
      "null",
      "[",
      JSON.stringify(Array(101).fill(1)),
    ])
      expect(parameters(input)).toBeNull();
    expect(parameters(JSON.stringify(Array(100).fill(null)))).toHaveLength(100);
  });
  it("quotes schema and table identifiers for each engine without making an executable suffix", () => {
    expect(selectTable(table, "postgres")).toBe('SELECT * FROM "public"."contacts"');
    expect(
      selectTable({ ...table, schema: null, name: 'x";DROP TABLE contacts;--' }, "postgres"),
    ).toBe('SELECT * FROM "x"";DROP TABLE contacts;--"');
    expect(selectTable({ ...table, schema: null, name: "a`b" }, "mysql")).toBe(
      "SELECT * FROM `a``b`",
    );
  });
  it("exports all returned rows, preserves JSON and escapes CSV formulas and quotes", () => {
    const data = {
      ...result(),
      columns: [{ name: "=header", type: "text" }],
      rows: [["=1+1"], [" +SUM(A1)"], ['a,"b"\nc'], [-2], [null], [{ value: "<script>" }]],
    };
    const output = csv(data);
    expect(output).toContain('"\'=header"\r\n"\'=1+1"');
    expect(output).toContain('"\' +SUM(A1)"');
    expect(output).toContain('"a,""b""\nc"');
    expect(output).toContain('"-2"\r\n""');
    expect(cellText({ data: [1] })).toBe('{"data":[1]}');
    expect(cellText(null)).toBe("NULL");
  });
});
