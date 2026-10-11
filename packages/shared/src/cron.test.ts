import { describe, expect, it } from "vitest";
import { cronTooFrequent, nextRun, parseCron } from "./cron.ts";

const at = (text: string) => new Date(text).getTime();
const next = (expression: string, after: string) => {
  const schedule = parseCron(expression);
  if (!schedule) throw new Error("invalid");
  const value = nextRun(schedule, at(after));
  return value === null ? null : new Date(value);
};

describe("cron", () => {
  it("rejects malformed expressions", () => {
    for (const bad of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "5-1 * * * *",
      "*/0 * * * *",
      "a * * * *",
    ])
      expect(parseCron(bad), bad).toBeNull();
  });

  it("finds the next minute, hour, day and month in local time", () => {
    expect(next("30 3 * * *", "2026-10-11T02:00:00")).toEqual(new Date("2026-10-11T03:30:00"));
    expect(next("30 3 * * *", "2026-10-11T03:30:00")).toEqual(new Date("2026-10-12T03:30:00"));
    expect(next("*/15 * * * *", "2026-10-11T10:07:00")).toEqual(new Date("2026-10-11T10:15:00"));
    expect(next("0 0 1 * *", "2026-10-11T00:00:00")).toEqual(new Date("2026-11-01T00:00:00"));
    expect(next("0 12 * 2 *", "2026-10-11T00:00:00")).toEqual(new Date("2027-02-01T12:00:00"));
    // Sunday as 0 or 7.
    expect(next("0 9 * * 7", "2026-10-11T10:00:00")).toEqual(new Date("2026-10-18T09:00:00"));
    expect(next("0 9 * * 1-5", "2026-10-10T10:00:00")).toEqual(new Date("2026-10-12T09:00:00"));
    // Both day fields restricted: either matches (Vixie cron).
    expect(next("0 0 13 * 5", "2026-10-11T00:00:00")).toEqual(new Date("2026-10-13T00:00:00"));
    // Impossible dates never match.
    expect(next("0 0 31 2 *", "2026-10-11T00:00:00")).toBeNull();
  });

  it("limits how often tasks run", () => {
    expect(cronTooFrequent(parseCron("* * * * *")!)).toBe(true);
    expect(cronTooFrequent(parseCron("*/2 * * * *")!)).toBe(true);
    expect(cronTooFrequent(parseCron("0,58 * * * *")!)).toBe(true);
    expect(cronTooFrequent(parseCron("*/5 * * * *")!)).toBe(false);
    expect(cronTooFrequent(parseCron("30 3 * * *")!)).toBe(false);
  });
});
