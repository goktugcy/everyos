import { describe, expect, it } from "vitest";
import {
  addMonths,
  localeWeekStart,
  monthGrid,
  startOfWeek,
  toInstant,
  toWall,
  zoneOffset,
} from "../src/dates.ts";
import { layoutDay } from "../src/layout.ts";
import { parseEvent, type CalendarEvent } from "../src/model.ts";
import {
  endSeriesBefore,
  fromRule,
  occurrences,
  occurrencesIn,
  ruleFrom,
  toRule,
  weekdayPosition,
  MAX_PER_RANGE,
} from "../src/recurrence.ts";
import { dueReminders, reminderTime } from "../src/reminders.ts";

const at = (iso: string) => Date.parse(iso);

function event(fields: Partial<CalendarEvent>): CalendarEvent {
  return parseEvent({
    id: "e1",
    uid: "e1@test",
    calendarId: "personal",
    title: "Standup",
    allDay: false,
    start: "2026-10-19T09:00",
    end: "2026-10-19T09:30",
    timeZone: "Europe/Berlin",
    location: "",
    notes: "",
    rrule: null,
    exdates: [],
    reminders: [],
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  })!;
}

describe("wall times and zones", () => {
  it("converts both ways, including daylight-saving changes", () => {
    expect(toInstant("2026-10-21T09:00", "Europe/Istanbul")).toBe(at("2026-10-21T06:00:00Z"));
    expect(toWall(at("2026-10-21T06:00:00Z"), "America/New_York")).toBe("2026-10-21T02:00");
    expect(zoneOffset(at("2026-07-01T00:00:00Z"), "Europe/Berlin")).toBe(2 * 3_600_000);
    expect(zoneOffset(at("2026-12-01T00:00:00Z"), "Europe/Berlin")).toBe(3_600_000);
    // 02:30 does not exist on the spring-forward night: it becomes 03:30.
    const skipped = toInstant("2026-03-29T02:30", "Europe/Berlin");
    expect(toWall(skipped, "Europe/Berlin")).toBe("2026-03-29T03:30");
    // 02:30 happens twice on the fall-back night: the first one.
    expect(toInstant("2026-10-25T02:30", "Europe/Berlin")).toBe(at("2026-10-25T00:30:00Z"));
  });

  it("lays out weeks and months where the person lives", () => {
    expect(monthGrid("2026-10-15", 1)[0]).toBe("2026-09-28");
    expect(monthGrid("2026-10-15", 0)[0]).toBe("2026-09-27");
    expect(monthGrid("2026-10-15", 1)).toHaveLength(42);
    expect(startOfWeek("2026-10-21", 1)).toBe("2026-10-19");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(localeWeekStart("tr")).toBe(1);
    expect(localeWeekStart("en-US")).toBe(0);
  });
});

describe("repeat rules", () => {
  it("writes and reads the rules the event dialog offers", () => {
    const cases: Array<[Parameters<typeof toRule>[0], string, string]> = [
      [
        { freq: "daily", interval: 1, byDay: [], monthly: "day", ends: { kind: "never" } },
        "2026-10-21",
        "FREQ=DAILY",
      ],
      [
        {
          freq: "weekly",
          interval: 2,
          byDay: [3, 1],
          monthly: "day",
          ends: { kind: "until", date: "2026-12-31" },
        },
        "2026-10-19",
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T235959Z",
      ],
      [
        {
          freq: "monthly",
          interval: 1,
          byDay: [],
          monthly: "weekday",
          ends: { kind: "count", count: 6 },
        },
        "2026-10-20",
        "FREQ=MONTHLY;BYDAY=3TU;COUNT=6",
      ],
      [
        { freq: "monthly", interval: 1, byDay: [], monthly: "weekday", ends: { kind: "never" } },
        "2026-10-30",
        "FREQ=MONTHLY;BYDAY=-1FR",
      ],
      [
        { freq: "monthly", interval: 3, byDay: [], monthly: "day", ends: { kind: "never" } },
        "2026-10-30",
        "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=30",
      ],
      [
        { freq: "yearly", interval: 1, byDay: [], monthly: "day", ends: { kind: "never" } },
        "2026-10-21",
        "FREQ=YEARLY",
      ],
    ];
    for (const [repeat, start, rule] of cases) {
      expect(toRule(repeat, start)).toBe(rule);
      expect(toRule(fromRule(rule, start)!, start), rule).toBe(rule);
    }
    expect(weekdayPosition("2026-10-30")).toBe(-1);
    // Rules from elsewhere that the dialog cannot show are kept as they are.
    expect(fromRule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR", "2026-10-30")).toBeNull();
    expect(fromRule("FREQ=MONTHLY;BYMONTHDAY=15", "2026-10-30")).toBeNull();
    expect(fromRule("FREQ=HOURLY", "2026-10-30")).toBeNull();
  });

  it("keeps the wall time across daylight-saving changes, for viewers anywhere", () => {
    const weekly = event({ rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3" });
    const found = occurrences(
      weekly,
      at("2026-10-01T00:00:00Z"),
      at("2026-12-01T00:00:00Z"),
      "Europe/Istanbul",
    );
    expect(found.map((occurrence) => occurrence.key)).toEqual([
      "2026-10-19T09:00",
      "2026-10-26T09:00",
      "2026-11-02T09:00",
    ]);
    // 09:00 in Berlin is 07:00Z in summer time and 08:00Z after it ends.
    expect(found.map((occurrence) => new Date(occurrence.start).toISOString())).toEqual([
      "2026-10-19T07:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
    ]);
    expect(found.every((occurrence) => occurrence.end - occurrence.start === 30 * 60_000)).toBe(
      true,
    );
    // Shown in Istanbul (UTC+3 all year): 10:00, then 11:00.
    expect(
      found.map((occurrence) => toWall(occurrence.start, "Europe/Istanbul").slice(11)),
    ).toEqual(["10:00", "11:00", "11:00"]);
  });

  it("skips exceptions, spans days for all-day events and caps long series", () => {
    const daily = event({ rrule: "FREQ=DAILY", exdates: ["2026-10-20T09:00"] });
    const days = occurrences(
      daily,
      at("2026-10-19T00:00:00Z"),
      at("2026-10-22T00:00:00Z"),
      "Europe/Berlin",
    );
    expect(days.map((occurrence) => occurrence.key)).toEqual([
      "2026-10-19T09:00",
      "2026-10-21T09:00",
    ]);

    const trip = event({
      allDay: true,
      start: "2026-10-20",
      end: "2026-10-23",
      timeZone: null,
      rrule: "FREQ=YEARLY",
    });
    const [first, second] = occurrences(
      trip,
      at("2026-01-01T00:00:00Z"),
      at("2028-01-01T00:00:00Z"),
      "Europe/Istanbul",
    );
    expect([first!.startDate, first!.endDate]).toEqual(["2026-10-20", "2026-10-23"]);
    expect(second!.key).toBe("2027-10-20");
    expect(first!.start).toBe(at("2026-10-19T21:00:00Z"));

    const forever = event({ rrule: "FREQ=DAILY" });
    expect(
      occurrences(forever, at("2026-01-01T00:00:00Z"), at("2036-01-01T00:00:00Z"), "UTC"),
    ).toHaveLength(MAX_PER_RANGE);
  });

  it("splits a series for changes to one occurrence and the ones after", () => {
    const series = event({ rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=5", exdates: ["2026-11-09T09:00"] });
    const before = endSeriesBefore(series, "2026-11-02T09:00")!;
    expect(before.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T085900Z");
    expect(before.exdates).toEqual([]);
    const kept = occurrences(
      before,
      at("2026-10-01T00:00:00Z"),
      at("2027-01-01T00:00:00Z"),
      "Europe/Berlin",
    );
    expect(kept.map((occurrence) => occurrence.key)).toEqual([
      "2026-10-19T09:00",
      "2026-10-26T09:00",
    ]);
    // The rest of a counted series keeps its remaining count.
    expect(ruleFrom(series, "2026-11-02T09:00")).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    expect(endSeriesBefore(series, "2026-10-19T09:00")).toBeNull();
  });

  it("orders a day: all-day first, then by start", () => {
    const meeting = event({ id: "m", title: "Meeting" });
    const holiday = event({
      id: "h",
      title: "Holiday",
      allDay: true,
      start: "2026-10-19",
      end: "2026-10-20",
      timeZone: null,
    });
    expect(
      occurrencesIn(
        [meeting, holiday],
        at("2026-10-18T22:00:00Z"),
        at("2026-10-19T22:00:00Z"),
        "Europe/Berlin",
      ).map((occurrence) => occurrence.event.title),
    ).toEqual(["Holiday", "Meeting"]);
  });
});

describe("day layout", () => {
  it("puts overlapping events side by side and the rest full width", () => {
    const make = (id: string, start: string, end: string) =>
      occurrences(
        event({ id, title: id, start, end, timeZone: "UTC" }),
        at("2026-10-19T00:00:00Z"),
        at("2026-10-20T00:00:00Z"),
        "UTC",
      )[0]!;
    const placed = layoutDay(
      [
        make("a", "2026-10-19T09:00", "2026-10-19T11:00"),
        make("b", "2026-10-19T10:00", "2026-10-19T12:00"),
        make("c", "2026-10-19T11:30", "2026-10-19T12:30"),
        make("d", "2026-10-19T14:00", "2026-10-19T14:05"),
      ],
      "2026-10-19",
      "UTC",
    );
    const by = (id: string) => placed.find((entry) => entry.occurrence.event.id === id)!;
    expect([by("a").lane, by("b").lane, by("c").lane]).toEqual([0, 1, 0]);
    expect([by("a").lanes, by("b").lanes, by("c").lanes]).toEqual([2, 2, 2]);
    expect(by("a").top).toBe(9 * 60);
    expect(by("a").height).toBe(120);
    expect([by("d").lanes, by("d").height]).toEqual([1, 20]);
  });

  it("cuts events that run past midnight at the day's edges", () => {
    const night = occurrences(
      event({ start: "2026-10-19T22:00", end: "2026-10-20T02:00", timeZone: "UTC" }),
      at("2026-10-19T00:00:00Z"),
      at("2026-10-21T00:00:00Z"),
      "UTC",
    );
    expect(layoutDay(night, "2026-10-19", "UTC")[0]).toMatchObject({ top: 22 * 60, height: 120 });
    expect(layoutDay(night, "2026-10-20", "UTC")[0]).toMatchObject({ top: 0, height: 120 });
  });
});

describe("reminders", () => {
  it("come due once, before the start (all-day: before 09:00 on the day)", () => {
    const meeting = event({
      start: "2026-10-21T10:00",
      end: "2026-10-21T11:00",
      timeZone: "UTC",
      reminders: [15],
    });
    expect(dueReminders([meeting], new Set(), at("2026-10-21T09:44:00Z"), "UTC")).toEqual([]);
    const due = dueReminders([meeting], new Set(), at("2026-10-21T09:45:00Z"), "UTC");
    expect(due.map((reminder) => reminder.key)).toEqual(["e1|2026-10-21T10:00|15"]);
    expect(
      dueReminders([meeting], new Set([due[0]!.key]), at("2026-10-21T09:50:00Z"), "UTC"),
    ).toEqual([]);
    // Over: no late reminder.
    expect(dueReminders([meeting], new Set(), at("2026-10-21T12:00:00Z"), "UTC")).toEqual([]);

    const birthday = event({
      allDay: true,
      start: "2026-10-22",
      end: "2026-10-23",
      timeZone: null,
      reminders: [1440],
    });
    const [occurrence] = occurrences(
      birthday,
      at("2026-10-22T00:00:00Z"),
      at("2026-10-23T00:00:00Z"),
      "Europe/Istanbul",
    );
    expect(new Date(reminderTime(occurrence!, 1440, "Europe/Istanbul")).toISOString()).toBe(
      "2026-10-21T06:00:00.000Z",
    );
  });
});
