import { RRule } from "rrule";
import {
  addDays,
  dateOf,
  daysBetween,
  fromWallMs,
  toInstant,
  toWall,
  wallMs,
  weekday,
  type LocalDate,
} from "./dates.ts";
import type { CalendarEvent } from "./model.ts";

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export type Ends =
  { kind: "never" } | { kind: "until"; date: LocalDate } | { kind: "count"; count: number };

/** A repeat rule the event dialog can show and edit. */
export interface Repeat {
  freq: Freq;
  interval: number;
  /** Weekly: days of the week (0 = Sunday). */
  byDay: number[];
  /** Monthly: on the same day number, or on the same weekday of the month ("third Tuesday"). */
  monthly: "day" | "weekday";
  ends: Ends;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export const MAX_INTERVAL = 99;
export const MAX_COUNT = 999;

/** Which of its weekdays in the month a date is: 1–4, or -1 for the fifth (the last). */
export function weekdayPosition(date: LocalDate): number {
  const position = Math.ceil(Number(date.slice(8, 10)) / 7);
  return position >= 5 ? -1 : position;
}

export function defaultRepeat(freq: Freq, start: LocalDate): Repeat {
  return { freq, interval: 1, byDay: [weekday(start)], monthly: "day", ends: { kind: "never" } };
}

export function toRule(repeat: Repeat, start: LocalDate): string {
  const parts = [`FREQ=${repeat.freq.toUpperCase()}`];
  const interval = Math.min(Math.max(1, Math.round(repeat.interval)), MAX_INTERVAL);
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (repeat.freq === "weekly") {
    const days = [...new Set(repeat.byDay.length ? repeat.byDay : [weekday(start)])].sort();
    parts.push(`BYDAY=${days.map((day) => DAYS[day]).join(",")}`);
  }
  if (repeat.freq === "monthly")
    parts.push(
      repeat.monthly === "weekday"
        ? `BYDAY=${weekdayPosition(start)}${DAYS[weekday(start)]}`
        : `BYMONTHDAY=${Number(start.slice(8, 10))}`,
    );
  if (repeat.ends.kind === "until")
    parts.push(`UNTIL=${repeat.ends.date.replace(/-/g, "")}T235959Z`);
  if (repeat.ends.kind === "count")
    parts.push(`COUNT=${Math.min(Math.max(1, Math.round(repeat.ends.count)), MAX_COUNT)}`);
  return parts.join(";");
}

/**
 * The editable form of a rule, or null for rules made elsewhere that it cannot express (they are
 * kept as they are and shown as a custom rule).
 */
export function fromRule(rule: string, start: LocalDate): Repeat | null {
  const fields = new Map<string, string>();
  for (const part of rule.split(";")) {
    const [name, value] = part.split("=");
    if (!name || value === undefined || fields.has(name.toUpperCase())) return null;
    fields.set(name.toUpperCase(), value.toUpperCase());
  }
  const freq = fields.get("FREQ")?.toLowerCase();
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly" && freq !== "yearly") return null;
  for (const name of fields.keys())
    if (!["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "UNTIL", "COUNT", "WKST"].includes(name))
      return null;
  const interval = fields.has("INTERVAL") ? Number(fields.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) return null;
  const repeat = defaultRepeat(freq, start);
  repeat.interval = interval;
  const byDay = fields.get("BYDAY");
  const byMonthDay = fields.get("BYMONTHDAY");
  if (freq === "daily" || freq === "yearly") {
    if (byDay || byMonthDay) return null;
  } else if (freq === "weekly") {
    if (byMonthDay) return null;
    if (byDay) {
      const days = byDay.split(",").map((day) => DAYS.indexOf(day as (typeof DAYS)[number]));
      if (days.some((day) => day < 0)) return null;
      repeat.byDay = days;
    }
  } else {
    if (byDay && byMonthDay) return null;
    if (byMonthDay && Number(byMonthDay) !== Number(start.slice(8, 10))) return null;
    if (byDay) {
      const match = /^(-?\d)([A-Z]{2})$/.exec(byDay);
      if (
        !match ||
        Number(match[1]) !== weekdayPosition(start) ||
        DAYS.indexOf(match[2] as (typeof DAYS)[number]) !== weekday(start)
      )
        return null;
      repeat.monthly = "weekday";
    }
  }
  const until = fields.get("UNTIL");
  const count = fields.get("COUNT");
  if (until && count) return null;
  if (until) {
    const match = /^(\d{4})(\d{2})(\d{2})/.exec(until);
    if (!match) return null;
    repeat.ends = { kind: "until", date: `${match[1]}-${match[2]}-${match[3]}` };
  } else if (count) {
    const value = Number(count);
    if (!Number.isInteger(value) || value < 1) return null;
    repeat.ends = { kind: "count", count: Math.min(value, MAX_COUNT) };
  }
  return repeat;
}

/** One time an event happens, placed for the person looking at it. */
export interface Occurrence {
  event: CalendarEvent;
  /** The occurrence's start in the event's own terms (wall time or date): its name in the series. */
  key: string;
  /** Instants (milliseconds). */
  start: number;
  end: number;
  /** Days it covers in the viewer's zone (end exclusive). */
  startDate: LocalDate;
  endDate: LocalDate;
}

const rules = new Map<string, RRule>();
function ruleOf(event: CalendarEvent): RRule | null {
  if (!event.rrule) return null;
  const cacheKey = `${event.start}|${event.rrule}`;
  let rule = rules.get(cacheKey);
  if (!rule) {
    try {
      // Wall times written as UTC: the rule steps through wall times, whatever the zone does.
      rule = new RRule({
        ...RRule.parseString(event.rrule),
        dtstart: new Date(wallMs(event.start)),
      });
    } catch {
      return null;
    }
    if (rules.size > 2000) rules.clear();
    rules.set(cacheKey, rule);
  }
  return rule;
}

/** At most this many occurrences of one event in one range (a view, a search). */
export const MAX_PER_RANGE = 1000;

function place(event: CalendarEvent, key: string, viewerZone: string): Occurrence {
  if (event.allDay) {
    const span = daysBetween(event.start, event.end);
    const startDate = dateOf(key);
    const endDate = addDays(startDate, span);
    return {
      event,
      key,
      start: toInstant(startDate, viewerZone),
      end: toInstant(endDate, viewerZone),
      startDate,
      endDate,
    };
  }
  const zone = event.timeZone ?? viewerZone;
  const duration = toInstant(event.end, zone) - toInstant(event.start, zone);
  const start = toInstant(key, zone);
  const end = start + Math.max(0, duration);
  return {
    event,
    key,
    start,
    end,
    startDate: dateOf(toWall(start, viewerZone)),
    endDate: addDays(dateOf(toWall(Math.max(start, end - 1), viewerZone)), 1),
  };
}

/** The occurrences of an event that overlap [from, to) (instants), in order. */
export function occurrences(
  event: CalendarEvent,
  from: number,
  to: number,
  viewerZone: string,
): Occurrence[] {
  // Overlapping the range; an event without length counts where it starts.
  const overlaps = ({ start, end }: Occurrence) =>
    start < to && (end > from || (end === start && start >= from));
  const rule = ruleOf(event);
  if (!event.rrule || !rule) {
    const single = place(event, event.start, viewerZone);
    return overlaps(single) ? [single] : [];
  }
  const span = wallMs(event.end) - wallMs(event.start);
  // Wall times and instants differ by a zone offset (under a day): search a little wider.
  const after = new Date(from - span - 2 * 86_400_000);
  const before = new Date(to + 2 * 86_400_000);
  const skipped = new Set(event.exdates);
  const found: Occurrence[] = [];
  rule.between(after, before, true, (date) => {
    const wall = fromWallMs(date.getTime());
    const key = event.allDay ? dateOf(wall) : wall;
    if (!skipped.has(key)) {
      const occurrence = place(event, key, viewerZone);
      if (overlaps(occurrence)) found.push(occurrence);
    }
    return found.length < MAX_PER_RANGE;
  });
  return found;
}

/** Every visible occurrence in a range, ordered by start (all-day first on the same start). */
export function occurrencesIn(
  events: readonly CalendarEvent[],
  from: number,
  to: number,
  viewerZone: string,
): Occurrence[] {
  return events
    .flatMap((event) => occurrences(event, from, to, viewerZone))
    .sort(
      (a, b) =>
        a.start - b.start ||
        Number(b.event.allDay) - Number(a.event.allDay) ||
        b.end - a.end ||
        a.event.title.localeCompare(b.event.title),
    );
}

const untilBefore = (event: CalendarEvent, key: string) =>
  event.allDay
    ? `${addDays(dateOf(key), -1).replace(/-/g, "")}T235959Z`
    : `${fromWallMs(wallMs(key) - 60_000).replace(/[-:]/g, "")}00Z`;

function withFields(rule: string, change: (fields: Map<string, string>) => void): string {
  const fields = new Map(
    rule.split(";").map((part) => {
      const [name = "", value = ""] = part.split("=");
      return [name.toUpperCase(), value] as const;
    }),
  );
  change(fields);
  return [...fields].map(([name, value]) => `${name}=${value}`).join(";");
}

/** How many times the series happens before an occurrence. */
function countBefore(event: CalendarEvent, key: string): number {
  const rule = ruleOf(event);
  if (!rule) return 0;
  return rule.between(new Date(wallMs(event.start) - 1), new Date(wallMs(key)), false).length;
}

/**
 * The series without an occurrence and the ones after it (for "this and following" changes);
 * null when that occurrence is the first, so nothing is left.
 */
export function endSeriesBefore(event: CalendarEvent, key: string): CalendarEvent | null {
  if (!event.rrule || wallMs(key) <= wallMs(event.start)) return null;
  return {
    ...event,
    rrule: withFields(event.rrule, (fields) => {
      fields.delete("COUNT");
      fields.set("UNTIL", untilBefore(event, key));
    }),
    exdates: event.exdates.filter((date) => wallMs(date) < wallMs(key)),
  };
}

/** The rule for a series that continues from an occurrence (the remaining count, if counted). */
export function ruleFrom(event: CalendarEvent, key: string): string | null {
  if (!event.rrule) return null;
  const count = /(?:^|;)COUNT=(\d+)/i.exec(event.rrule);
  if (!count) return event.rrule;
  const remaining = Number(count[1]) - countBefore(event, key);
  return withFields(event.rrule, (fields) => fields.set("COUNT", String(Math.max(1, remaining))));
}
