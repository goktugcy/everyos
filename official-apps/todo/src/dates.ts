/*
 * Calendar dates as "YYYY-MM-DD" strings in the person's local time: due dates are days, not
 * instants, so they never shift with time zones or daylight saving.
 */

export type DateKey = string;

export function toKey(date: Date): DateKey {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function fromKey(key: DateKey): Date {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toKey(fromKey(value)) === value;
}

export function todayKey(now: number = Date.now()): DateKey {
  return toKey(new Date(now));
}

export function addDays(key: DateKey, days: number): DateKey {
  const date = fromKey(key);
  date.setDate(date.getDate() + days);
  return toKey(date);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Day of the week, 0 Sunday … 6 Saturday. */
export function weekday(key: DateKey): number {
  return fromKey(key).getDay();
}

export function compareKeys(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: DateKey, b: DateKey): number {
  const start = fromKey(a);
  const end = fromKey(b);
  return Math.round(
    (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      86_400_000,
  );
}

/** The local time of a due date and optional "HH:MM". */
export function dueInstant(due: DateKey, time: string | null): number {
  const date = fromKey(due);
  if (time) {
    const [hours = 0, minutes = 0] = time.split(":").map(Number);
    date.setHours(hours, minutes, 0, 0);
  } else date.setHours(9, 0, 0, 0);
  return date.getTime();
}
