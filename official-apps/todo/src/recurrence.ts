import { addDays, daysInMonth, fromKey, toKey, weekday, type DateKey } from "./dates.ts";

/*
 * Repeating tasks. Completing one moves its due date to the next occurrence after the current
 * one. Months and years keep the day they started on: a task on the 31st falls on the last day
 * of shorter months and returns to the 31st after them; one on 29 February falls on the 28th in
 * other years.
 */

export interface Recurrence {
  unit: "day" | "weekday" | "week" | "month" | "year";
  /** Every n days/weeks/months/years (1–365). */
  interval: number;
  /** Weekly: days of the week (0 Sunday … 6 Saturday); empty means the due date's own day. */
  weekdays: number[];
  /** Monthly: the same day number, or the same weekday of the month (e.g. the 2nd Tuesday). */
  monthMode: "day" | "weekday";
  /** The day of the month (1–31) or the date the series started on, kept across short months. */
  anchor: DateKey;
}

export function makeRecurrence(
  unit: Recurrence["unit"],
  anchor: DateKey,
  options: Partial<Pick<Recurrence, "interval" | "weekdays" | "monthMode">> = {},
): Recurrence {
  return {
    unit,
    interval: Math.min(365, Math.max(1, Math.round(options.interval ?? 1))),
    weekdays: [...new Set(options.weekdays ?? [])].filter((day) => day >= 0 && day <= 6).sort(),
    monthMode: options.monthMode ?? "day",
    anchor,
  };
}

function clampedDate(year: number, monthIndex: number, day: number): DateKey {
  return toKey(new Date(year, monthIndex, Math.min(day, daysInMonth(year, monthIndex))));
}

/** Which occurrence of its weekday a date is in its month (1–5), and whether it is the last. */
function weekdayOrdinal(key: DateKey): { ordinal: number; last: boolean } {
  const date = fromKey(key);
  const ordinal = Math.floor((date.getDate() - 1) / 7) + 1;
  const last = date.getDate() + 7 > daysInMonth(date.getFullYear(), date.getMonth());
  return { ordinal, last };
}

/** The n-th given weekday of a month (n 5 or "last" falls back to the last one). */
function nthWeekday(
  year: number,
  monthIndex: number,
  day: number,
  ordinal: number,
  last: boolean,
): DateKey {
  if (last || ordinal >= 5) {
    const end = new Date(year, monthIndex, daysInMonth(year, monthIndex));
    end.setDate(end.getDate() - ((end.getDay() - day + 7) % 7));
    return toKey(end);
  }
  const first = new Date(year, monthIndex, 1);
  const offset = (day - first.getDay() + 7) % 7;
  return toKey(new Date(year, monthIndex, 1 + offset + (ordinal - 1) * 7));
}

/** Monday of the week a date is in (weeks for "every n weeks" are counted Monday to Sunday). */
function mondayOf(key: DateKey): DateKey {
  return addDays(key, -((weekday(key) + 6) % 7));
}

/** The next occurrence strictly after `from`. */
export function nextOccurrence(rule: Recurrence, from: DateKey): DateKey {
  switch (rule.unit) {
    case "day":
      return addDays(from, rule.interval);
    case "weekday": {
      let next = addDays(from, 1);
      while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
      return next;
    }
    case "week": {
      const days = rule.weekdays.length ? rule.weekdays : [weekday(rule.anchor)];
      // Later this week, or the first chosen day `interval` weeks on.
      const order = (day: number) => (day + 6) % 7;
      const current = order(weekday(from));
      const later = days
        .map(order)
        .filter((day) => day > current)
        .sort((a, b) => a - b)[0];
      const monday = mondayOf(from);
      if (later !== undefined) return addDays(monday, later);
      const first = Math.min(...days.map(order));
      return addDays(monday, rule.interval * 7 + first);
    }
    case "month": {
      const date = fromKey(from);
      const target = date.getMonth() + rule.interval;
      const year = date.getFullYear() + Math.floor(target / 12);
      const month = ((target % 12) + 12) % 12;
      if (rule.monthMode === "weekday") {
        const { ordinal, last } = weekdayOrdinal(rule.anchor);
        return nthWeekday(year, month, weekday(rule.anchor), ordinal, last);
      }
      return clampedDate(year, month, fromKey(rule.anchor).getDate());
    }
    case "year": {
      const date = fromKey(from);
      const anchor = fromKey(rule.anchor);
      return clampedDate(date.getFullYear() + rule.interval, anchor.getMonth(), anchor.getDate());
    }
  }
}

export function isRecurrence(value: unknown): value is Recurrence {
  const rule = value as Partial<Recurrence> | null;
  return (
    !!rule &&
    ["day", "weekday", "week", "month", "year"].includes(rule.unit ?? "") &&
    typeof rule.interval === "number" &&
    Array.isArray(rule.weekdays) &&
    (rule.monthMode === "day" || rule.monthMode === "weekday") &&
    typeof rule.anchor === "string"
  );
}
