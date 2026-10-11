/*
 * Minimal cron (5 fields: minute hour day-of-month month day-of-week) for
 * scheduled tasks, evaluated in the server's local time. Supports "*", lists,
 * ranges and steps; day-of-week 0 and 7 are Sunday. As in Vixie cron, when
 * both day fields are restricted a day matching either one is used.
 */

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

function parseField(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    let from = min;
    let to = max;
    if (match[2] !== undefined) {
      from = Number(match[2]);
      to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from;
    }
    const step = match[4] !== undefined ? Number(match[4]) : 1;
    if (from < min || to > max || from > to || step < 1) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || expression.length > 100) return null;
  const fields = parts.map((part, index) =>
    parseField(part, FIELDS[index]!.min, FIELDS[index]!.max),
  );
  if (fields.some((field) => field === null)) return null;
  const [minutes, hours, days, months, weekdays] = fields as Set<number>[];
  if (weekdays!.has(7)) weekdays!.add(0);
  return {
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays: weekdays!,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const day = schedule.days.has(date.getDate());
  const weekday = schedule.weekdays.has(date.getDay());
  if (schedule.anyDay && schedule.anyWeekday) return true;
  if (schedule.anyDay) return weekday;
  if (schedule.anyWeekday) return day;
  return day || weekday;
}

/** The first matching minute strictly after `after` (epoch ms), or null within 5 years. */
export function nextRun(schedule: CronSchedule, after: number): number | null {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after + 5 * 366 * 24 * 60 * 60_000;
  while (date.getTime() <= limit) {
    if (!schedule.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
    } else if (!dayMatches(schedule, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (!schedule.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
    } else if (!schedule.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
    } else {
      return date.getTime();
    }
  }
  return null;
}

/** Tasks may run at most every five minutes (bounded load on small hosts). */
export function cronTooFrequent(schedule: CronSchedule): boolean {
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  if (minutes.length > 12) return true;
  if (minutes.length < 2) return false;
  const gaps = minutes.map((value, index) => (minutes[index + 1] ?? minutes[0]! + 60) - value);
  return Math.min(...gaps) < 5;
}
