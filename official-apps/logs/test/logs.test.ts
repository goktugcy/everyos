import type { LogEntry, LogPage } from "@everyos/app-sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAFT,
  MAX_BYTES,
  MAX_ENTRIES,
  localTime,
  logReport,
  mergeLogs,
  queryFor,
  readDraft,
  readPresets,
} from "../src/logs.ts";

export const entry = (cursor: string, ts: number, message = "message"): LogEntry => ({
  cursor,
  ts,
  message,
  priority: 6,
  unit: "cache.service",
  identifier: "cache",
  pid: 10,
  hostname: "host.test",
});
const page = (
  entries: LogEntry[],
  hasMore = false,
  source: LogPage["source"] = "host",
): LogPage => ({ entries, hasMore, source });

describe("log filters", () => {
  it("validates exact unit names, literal search, severity threshold and moving relative windows", () => {
    expect(
      queryFor(
        { ...DEFAULT_DRAFT, unit: "cache@home.service", search: " [cache]. ", priority: "4" },
        7200000,
      ),
    ).toEqual({
      query: {
        unit: "cache@home.service",
        grep: "[cache].",
        priority: 4,
        since: 3600000,
        limit: 200,
      },
    });
    expect(queryFor({ ...DEFAULT_DRAFT, range: "all" }, 7200000)).toEqual({
      query: { limit: 200 },
    });
  });
  it.each([
    "../cache.service",
    "--since=now.service",
    "cache..service",
    "*.service",
    "cache",
    "cache.service/other",
  ])("refuses invalid unit %s", (unit) => {
    expect(queryFor({ ...DEFAULT_DRAFT, unit }, 7200000)).toEqual({ error: "unit" });
  });
  it("rejects malformed priorities, search text, ranges and invalid or reversed local timestamps", () => {
    expect(queryFor({ ...DEFAULT_DRAFT, priority: "8" }, 0)).toEqual({ error: "priority" });
    expect(queryFor({ ...DEFAULT_DRAFT, search: "a".repeat(201) }, 0)).toEqual({ error: "search" });
    expect(queryFor({ ...DEFAULT_DRAFT, search: "a\0b" }, 0)).toEqual({ error: "search" });
    expect(queryFor({ ...DEFAULT_DRAFT, range: "toString" }, 0)).toEqual({ error: "range" });
    for (const since of ["2025-02-29T12:00", "invalid", "1960-01-01T00:00", ""]) {
      expect(queryFor({ ...DEFAULT_DRAFT, range: "custom", since }, 0)).toEqual({ error: "time" });
    }
    expect(
      queryFor(
        { ...DEFAULT_DRAFT, range: "custom", since: "2026-10-23T12:00", until: "2026-10-22T12:00" },
        0,
      ),
    ).toEqual({ error: "time" });
    const at = new Date(2026, 9, 22, 12, 30).getTime();
    expect(queryFor({ ...DEFAULT_DRAFT, range: "custom", since: localTime(at) }, 0)).toEqual({
      query: { since: at, limit: 200 },
    });
  });
  it("recovers bounded drafts and only accepts valid, distinct saved filters", () => {
    expect(
      readDraft({ unit: 7, search: "a".repeat(500), priority: "bad", range: "toString" }),
    ).toEqual({ ...DEFAULT_DRAFT, search: "a".repeat(200) });
    const valid = { id: "saved-1", name: " Cache ", draft: DEFAULT_DRAFT };
    expect(
      readPresets([
        valid,
        valid,
        { id: "bad", name: "Bad", draft: {} },
        { ...valid, id: "invalid", draft: { ...DEFAULT_DRAFT, unit: "../bad" } },
      ]),
    ).toEqual([{ ...valid, name: "Cache" }]);
    expect(
      readPresets(Array.from({ length: 30 }, (_, i) => ({ ...valid, id: String(i) }))),
    ).toHaveLength(20);
  });
});

describe("bounded log views", () => {
  it("merges newest and older pages by cursor without mutating records and preserves pagination", () => {
    const first = page([entry("b", 20), entry("a", 10)], true);
    const view = mergeLogs(null, first, "replace", { limit: 200 }, 100);
    const newer = mergeLogs(
      view,
      page([entry("c", 30), entry("b", 20)]),
      "tail",
      { limit: 200 },
      200,
    );
    expect(newer.entries.map((row) => row.cursor)).toEqual(["c", "b", "a"]);
    expect(newer.hasMore).toBe(true);
    const older = mergeLogs(
      newer,
      page([entry("a", 10), entry("old", 5)]),
      "older",
      { limit: 200 },
      300,
    );
    expect(older.entries.map((row) => row.cursor)).toEqual(["c", "b", "a", "old"]);
    expect(older.hasMore).toBe(false);
    expect(first.entries.map((row) => row.cursor)).toEqual(["b", "a"]);
  });
  it("does not mix sources and prunes entries outside the current time window", () => {
    const old = mergeLogs(null, page([entry("a", 10)]), "replace", { limit: 200 }, 100);
    const simulated = mergeLogs(
      old,
      page([entry("s", 20)], false, "simulated"),
      "tail",
      { limit: 200 },
      200,
    );
    expect(simulated.source).toBe("simulated");
    expect(simulated.entries.map((row) => row.cursor)).toEqual(["s"]);
    const recent = mergeLogs(
      old,
      page([entry("b", 30), entry("c", 40)]),
      "tail",
      { limit: 200, since: 20, until: 35 },
      300,
    );
    expect(recent.entries.map((row) => row.cursor)).toEqual(["b"]);
  });
  it("bounds both entry count and encoded bytes and records live gaps honestly", () => {
    const many = mergeLogs(
      null,
      page(Array.from({ length: 1200 }, (_, i) => entry(String(i), i))),
      "replace",
      { limit: 200 },
      100,
    );
    expect(many.entries).toHaveLength(MAX_ENTRIES);
    expect(many.limited).toBe(true);
    expect(many.hasMore).toBe(true);
    const large = mergeLogs(
      null,
      page(Array.from({ length: 500 }, (_, i) => entry(String(i), i, "x".repeat(16384)))),
      "replace",
      { limit: 200 },
      100,
    );
    expect(large.bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(large.entries.length).toBeLessThan(500);
    expect(large.limited).toBe(true);
    const gap = mergeLogs(many, page([entry("new", 2000)], true), "tail", { limit: 200 }, 200);
    expect(gap.gap).toBe(true);
    expect(logReport(gap, DEFAULT_DRAFT, 300)).toMatchObject({
      source: "host",
      limited: true,
      gap: true,
      generatedAt: 300,
    });
  });
});
