/*
 * Calendar dates and wall times as strings ("2026-10-21", "2026-10-21T09:30"), and conversions
 * between a wall time in a time zone and an instant. Events keep the wall time and zone they were
 * made in, so "every Monday at 9:00" stays at 9:00 across daylight-saving changes.
 */

export type LocalDate = string;
export type LocalDateTime = string;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const isLocalDate = (value: unknown): value is LocalDate =>
  typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
export const isLocalDateTime = (value: unknown): value is LocalDateTime =>
  typeof value === "string" &&
  DATE_TIME.test(value) &&
  !Number.isNaN(Date.parse(`${value}:00Z`)) &&
  Number(value.slice(11, 13)) < 24 &&
  Number(value.slice(14, 16)) < 60;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** A wall time as if it were UTC (milliseconds): the floating form date math works on. */
export function wallMs(value: LocalDate): number {
  return Date.parse(value.length === 10 ? `${value}T00:00:00Z` : `${value}:00Z`);
}

export function fromWallMs(ms: number): LocalDateTime {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
}

export const dateOf = (value: LocalDateTime): LocalDate => value.slice(0, 10);
export const timeOf = (value: LocalDateTime): string => value.slice(11, 16);
export const join = (date: LocalDate, time: string): LocalDateTime => `${date}T${time}`;

export function addDays(date: LocalDate, days: number): LocalDate {
  return dateOf(fromWallMs(wallMs(date) + days * 86_400_000));
}

export function addMinutes(value: LocalDateTime, minutes: number): LocalDateTime {
  return fromWallMs(wallMs(value) + minutes * 60_000);
}

export const daysBetween = (from: LocalDate, to: LocalDate) =>
  Math.round((wallMs(to) - wallMs(from)) / 86_400_000);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: LocalDate) => new Date(wallMs(date)).getUTCDay();

export function startOfWeek(date: LocalDate, weekStart: number): LocalDate {
  return addDays(date, -((weekday(date) - weekStart + 7) % 7));
}

export function startOfMonth(date: LocalDate): LocalDate {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(day, last))}`;
}

/** The six weeks a month view shows, starting on the week's first day. */
export function monthGrid(month: LocalDate, weekStart: number): LocalDate[] {
  const first = startOfWeek(startOfMonth(month), weekStart);
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(ms: number, timeZone: string): Record<string, number> {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(ms))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return parts;
}

/** The zone's offset from UTC at an instant, in milliseconds (east positive). */
export function zoneOffset(ms: number, timeZone: string): number {
  const parts = partsIn(ms, timeZone);
  const wall = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day,
    parts.hour! % 24,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall time happens in a zone. A time skipped by a daylight-saving change moves
 * forward by the change (02:30 on a spring-forward night is 03:30); a repeated one takes the
 * first time it happens.
 */
export function toInstant(value: LocalDateTime, timeZone: string): number {
  const wall = wallMs(value);
  // A zone changes its offset at most once a day: the offsets half a day either side cover it.
  const before = zoneOffset(wall - 43_200_000, timeZone);
  const after = zoneOffset(wall + 43_200_000, timeZone);
  const matches = [wall - before, wall - after].filter(
    (ms) => ms + zoneOffset(ms, timeZone) === wall,
  );
  return matches.length ? Math.min(...matches) : wall - before;
}

/** The wall time of an instant in a zone. */
export function toWall(ms: number, timeZone: string): LocalDateTime {
  return fromWallMs(ms + zoneOffset(ms, timeZone));
}

/** Whether a value names a time zone this device knows (a plain check: no narrowing). */
export function isTimeZone(value: unknown): boolean {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The first day of the week where the person lives (0 = Sunday), from the locale. */
export function localeWeekStart(locale: string): number {
  try {
    const info =
      (
        new Intl.Locale(locale) as Intl.Locale & {
          getWeekInfo?: () => { firstDay: number };
          weekInfo?: { firstDay: number };
        }
      ).getWeekInfo?.() ??
      (new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay: number } }).weekInfo;
    if (info) return info.firstDay % 7;
  } catch {
    // Older engines: fall through.
  }
  return /^(en-US|en-CA|ja|ko|zh|he|pt-BR)/.test(locale) ? 0 : 1;
}
