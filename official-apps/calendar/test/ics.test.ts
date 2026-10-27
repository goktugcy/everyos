import { describe, expect, it } from "vitest";
import { durationMinutes, fold, parseIcs, resolveZone, toIcs } from "../src/ics.ts";
import { occurrences } from "../src/recurrence.ts";

const at = (iso: string) => Date.parse(iso);

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//EN",
  "X-WR-CALNAME:Work",
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "DTSTART;TZID=Europe/Berlin:20261019T090000",
  "DTEND;TZID=Europe/Berlin:20261019T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T080000Z",
  "EXDATE;TZID=Europe/Berlin:20261026T090000",
  "SUMMARY:Team standup\\, weekly",
  "DESCRIPTION:Line one\\nLine two with a very long text that has to be folded because it goes",
  "  past seventy-five octets",
  "LOCATION:Room 4\\; east wing",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "RECURRENCE-ID;TZID=Europe/Berlin:20261102T090000",
  "DTSTART;TZID=Europe/Berlin:20261102T100000",
  "DTEND;TZID=Europe/Berlin:20261102T103000",
  "SUMMARY:Team standup (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:holiday@example.com",
  "DTSTART;VALUE=DATE:20261029",
  "DTEND;VALUE=DATE:20261030",
  "SUMMARY:Republic Day",
  "BEGIN:VALARM",
  "TRIGGER:-PT15H",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:outlook@example.com",
  "DTSTART;TZID=Pacific Standard Time:20261021T080000",
  "DURATION:PT1H30M",
  "SUMMARY:Call",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gone@example.com",
  "STATUS:CANCELLED",
  "DTSTART:20261021T080000Z",
  "SUMMARY:Cancelled",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("iCalendar import", () => {
  const imported = parseIcs(SAMPLE, { calendarId: "work", viewerZone: "Europe/Istanbul", now: 5 });
  const byTitle = (title: string) => imported.events.find((event) => event.title === title)!;

  it("reads events, text, zones, rules, exceptions and reminders", () => {
    expect(imported.name).toBe("Work");
    expect(imported.skipped).toBe(1);
    expect(imported.events.map((event) => event.title).sort()).toEqual([
      "Call",
      "Republic Day",
      "Team standup (moved)",
      "Team standup, weekly",
    ]);
    const standup = byTitle("Team standup, weekly");
    expect(standup).toMatchObject({
      uid: "standup@example.com",
      calendarId: "work",
      allDay: false,
      start: "2026-10-19T09:00",
      end: "2026-10-19T09:30",
      timeZone: "Europe/Berlin",
      location: "Room 4; east wing",
      reminders: [15],
    });
    expect(standup.notes).toBe(
      "Line one\nLine two with a very long text that has to be folded because it goes past seventy-five octets",
    );
    // The moved occurrence is left out of the series and stands on its own.
    expect(standup.exdates.sort()).toEqual(["2026-10-26T09:00", "2026-11-02T09:00"]);
    expect(byTitle("Team standup (moved)")).toMatchObject({
      start: "2026-11-02T10:00",
      rrule: null,
    });
    const keys = occurrences(
      standup,
      at("2026-10-01T00:00:00Z"),
      at("2026-12-31T00:00:00Z"),
      "Europe/Berlin",
    ).map((occurrence) => occurrence.key);
    // UNTIL 08:00Z on 9 November is 09:00 in Berlin: that occurrence is the last.
    expect(keys).toEqual(["2026-10-19T09:00", "2026-11-09T09:00"]);

    // A day-before-at-09:00 alarm of an all-day event.
    expect(byTitle("Republic Day")).toMatchObject({
      allDay: true,
      start: "2026-10-29",
      end: "2026-10-30",
      reminders: [1440],
    });
    // Outlook's zone names, and DURATION instead of DTEND.
    expect(byTitle("Call")).toMatchObject({
      timeZone: "America/Los_Angeles",
      start: "2026-10-21T08:00",
      end: "2026-10-21T09:30",
    });
  });

  it("knows zones by IANA name, path or Windows name", () => {
    expect(resolveZone("Europe/Istanbul")).toBe("Europe/Istanbul");
    expect(resolveZone("/mozilla.org/20050126_1/Europe/London")).toBe("Europe/London");
    expect(resolveZone("Turkey Standard Time")).toBe("Europe/Istanbul");
    expect(resolveZone("Mars/Olympus")).toBeNull();
    expect(durationMinutes("-P1DT2H")).toBe(-1560);
    expect(durationMinutes("P1W")).toBe(10_080);
    expect(durationMinutes("P")).toBeNull();
  });

  it("refuses files that are not calendars", () => {
    expect(() => parseIcs("hello", { calendarId: "x", viewerZone: "UTC", now: 0 })).toThrow(
      SyntaxError,
    );
  });
});

describe("iCalendar export", () => {
  it("writes a file other calendars read the same way", () => {
    const imported = parseIcs(SAMPLE, {
      calendarId: "work",
      viewerZone: "Europe/Istanbul",
      now: 5,
    });
    const text = toIcs(imported.events, "Work", at("2026-10-21T12:00:00Z"));
    expect(text.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(
      true,
    );
    expect(text).toContain("DTSTART;TZID=Europe/Berlin:20261019T090000\r\n");
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T080000Z\r\n");
    expect(text).toContain("DTSTART;VALUE=DATE:20261029\r\n");
    expect(text).toContain("TRIGGER:-PT15M\r\n");
    expect(text).toContain("SUMMARY:Team standup\\, weekly\r\n");

    const again = parseIcs(text, { calendarId: "work", viewerZone: "Europe/Istanbul", now: 5 });
    const strip = (events: typeof imported.events) =>
      events
        .map(({ id: _id, createdAt: _created, updatedAt: _updated, ...rest }) => ({
          ...rest,
          exdates: [...rest.exdates].sort(),
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
    expect(strip(again.events)).toEqual(strip(imported.events));
  });

  it("escapes backslashes, semicolons, commas and line breaks both ways", () => {
    const [event] = parseIcs(SAMPLE, { calendarId: "work", viewerZone: "UTC", now: 0 }).events;
    const tricky = { ...event!, title: String.raw`C:\temp; a, b` + "\nnext" };
    const text = toIcs([tricky], "Work", 0);
    expect(text).toContain(String.raw`SUMMARY:C:\\temp\; a\, b\nnext`);
    expect(parseIcs(text, { calendarId: "work", viewerZone: "UTC", now: 0 }).events[0]!.title).toBe(
      tricky.title,
    );
  });

  it("folds long lines without splitting characters", () => {
    const line = `SUMMARY:${"ğ".repeat(60)}`;
    const folded = fold(line);
    expect(folded.split("\r\n ").join("")).toBe(line);
    for (const part of folded.split("\r\n"))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
  });
});
