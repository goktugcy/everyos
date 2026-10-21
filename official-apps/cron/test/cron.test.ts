import { describe, expect, it } from "vitest";
import {
  CronError,
  fieldMode,
  fieldText,
  forEveryOSTask,
  parseCron,
  parseField,
  PRESETS,
  toOnCalendar,
} from "../src/cron.ts";
import { describe as describeCron, runs } from "../src/runs.ts";

const problem = (expression: string, seconds = false) => {
  try {
    parseCron(expression, seconds);
  } catch (error) {
    if (error instanceof CronError) return [error.problem, error.field, error.token];
  }
  return null;
};

describe("parsing", () => {
  it("reads numbers, lists, ranges, steps, names and 7 as Sunday", () => {
    expect(parseField("*/15", "minute").values).toEqual([0, 15, 30, 45]);
    expect(parseField("1-10/3", "day").values).toEqual([1, 4, 7, 10]);
    expect(parseField("MON-FRI", "weekday").values).toEqual([1, 2, 3, 4, 5]);
    expect(parseField("0,7", "weekday").values).toEqual([0]);
    expect(parseField("jan,Jul", "month").values).toEqual([1, 7]);
    expect(parseField("5/20", "minute").values).toEqual([5, 25, 45]);
    expect(parseCron("@daily").normalized).toBe("0 0 * * *");
    expect(parseCron("30 0 9 * * 1", true).seconds).toBe(true);
  });

  it("says precisely what is wrong", () => {
    expect(problem("* * * *")).toEqual(["field-count", null, "4"]);
    expect(problem("60 * * * *")).toEqual(["out-of-range", "minute", "60"]);
    expect(problem("* 25 * * *")).toEqual(["out-of-range", "hour", "25"]);
    expect(problem("* * 0 * *")).toEqual(["out-of-range", "day", "0"]);
    expect(problem("* * * 5-2 *")).toEqual(["bad-range", "month", "5-2"]);
    expect(problem("*/0 * * * *")).toEqual(["bad-step", "minute", "*/0"]);
    expect(problem("* * * * FUNDAY")).toEqual(["bad-token", "weekday", "FUNDAY"]);
    expect(problem("1,,2 * * * *")).toEqual(["bad-token", "minute", "1,,2"]);
    expect(problem("@reboot")).toEqual(["reboot", null, ""]);
    expect(problem("0 0 9 * * 1")).toEqual(["field-count", null, "6"]);
  });
});

describe("the builder", () => {
  it("reads and writes the forms it shows", () => {
    expect(fieldMode("*", "minute")).toEqual({ mode: "every" });
    expect(fieldMode("1,15", "day")).toEqual({ mode: "specific", values: [1, 15] });
    expect(fieldMode("9-17", "hour")).toEqual({ mode: "range", from: 9, to: 17 });
    expect(fieldMode("*/5", "minute")).toEqual({ mode: "step", start: 0, every: 5 });
    expect(fieldMode("10-59/5", "minute")).toEqual({ mode: "step", start: 10, every: 5 });
    expect(fieldMode("1-10/2,20", "day")).toBeNull();
    expect(fieldText({ mode: "step", start: 10, every: 5 }, "minute")).toBe("10-59/5");
    expect(fieldText({ mode: "step", start: 0, every: 5 }, "minute")).toBe("*/5");
    expect(fieldText({ mode: "specific", values: [15, 1, 15] }, "day")).toBe("1,15");
    expect(fieldText({ mode: "step", start: 1, every: 2 }, "weekday")).toBe("1-6/2");
  });
});

describe("conversions", () => {
  const calendar = (expression: string) => toOnCalendar(parseCron(expression));
  it("writes systemd OnCalendar lines", () => {
    expect(calendar("*/15 9-17 * * 1-5")).toEqual(["Mon..Fri *-*-* 09..17:00/15:00"]);
    expect(calendar("0 3 * * *")).toEqual(["*-*-* 03:00:00"]);
    expect(calendar("@monthly")).toEqual(["*-*-01 00:00:00"]);
    expect(calendar("0 0 1 1,4,7,10 *")).toEqual(["*-01,04,07,10-01 00:00:00"]);
    expect(calendar("5,10,15 * * * 0,6")).toEqual(["Sun,Sat *-*-* *:05,10,15:00"]);
    expect(calendar("0 12 1-10/3 * *")).toEqual(["*-*-01,04,07,10 12:00:00"]);
    expect(toOnCalendar(parseCron("30 0 9 * * *", true))).toEqual(["*-*-* 09:00:30"]);
    // Cron's "either day" becomes two systemd lines.
    expect(calendar("0 8 1 * MON")).toEqual(["*-*-01 08:00:00", "Mon *-*-* 08:00:00"]);
  });

  it("checks EveryOS Scheduled Tasks rules and writes numbers", () => {
    expect(forEveryOSTask("0 9 * * MON-FRI")).toEqual({ expression: "0 9 * * 1-5", problems: [] });
    expect(forEveryOSTask("@daily")).toEqual({ expression: "0 0 * * *", problems: [] });
    expect(forEveryOSTask("*/5 * * * *").problems).toEqual([]);
    expect(forEveryOSTask("*/2 * * * *").problems).toEqual(["too-frequent"]);
    expect(forEveryOSTask("0,3 * * * *").problems).toEqual(["too-frequent"]);
    expect(forEveryOSTask("0 0 9 * * *").problems).toEqual(["seconds"]);
  });
});

describe("descriptions and run times", () => {
  it("describes in the person's language", () => {
    expect(describeCron("0 9 * * 1-5", "en")).toMatch(/09:00 AM.*Monday through Friday/);
    expect(describeCron("0 9 * * 1-5", "tr")).toMatch(/09:00.*Pazartesi/);
    expect(describeCron("0 9 * * 1-5", "zh")).toMatch(/星期一/);
    for (const preset of PRESETS) expect(describeCron(preset.expression, "de")).not.toBe("");
  });

  it("computes the next and previous runs in a time zone", () => {
    const from = new Date("2026-10-21T10:00:00Z");
    expect(
      runs("0 9 * * 1-5", "Europe/Istanbul", from, 3).map((date) => date.toISOString()),
    ).toEqual(["2026-10-22T06:00:00.000Z", "2026-10-23T06:00:00.000Z", "2026-10-26T06:00:00.000Z"]);
    expect(runs("0 9 * * 1-5", "America/New_York", from, 1)[0]!.toISOString()).toBe(
      "2026-10-21T13:00:00.000Z",
    );
    expect(runs("0 0 30 2 *", "UTC", from, 3)).toEqual([]);
    expect(runs("0 * * * *", "UTC", from, 2, "prev").map((date) => date.toISOString())).toEqual([
      "2026-10-21T09:00:00.000Z",
      "2026-10-21T08:00:00.000Z",
    ]);
  });
});
