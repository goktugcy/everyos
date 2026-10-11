import { describe, expect, it } from "vitest";
import { fromCron, previewNext, toCron } from "./schedule.ts";

describe("schedule editor", () => {
  it("round-trips presets and keeps anything else as custom", () => {
    for (const expression of ["15 * * * *", "30 3 * * *", "0 22 * * 5", "45 1 14 * *"])
      expect(toCron(fromCron(expression))).toBe(expression);
    expect(fromCron("0 9 * * 7")).toEqual({ mode: "weekly", weekday: 0, hour: 9, minute: 0 });
    expect(fromCron("*/15 * * * *")).toEqual({ mode: "custom", expression: "*/15 * * * *" });
    expect(fromCron("0 9 * * 1-5").mode).toBe("custom");
  });

  it("previews the next run or reports an invalid schedule", () => {
    const now = new Date("2026-10-11T02:00:00").getTime();
    expect(previewNext("30 3 * * *", now)).toBe(new Date("2026-10-11T03:30:00").getTime());
    expect(previewNext("not cron", now)).toBeNull();
  });
});
