import type { Session } from "./timer.ts";

/** Local calendar day of a time, as YYYY-MM-DD. */
export function dayKey(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(time: number, days: number): number {
  const date = new Date(time);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export interface DayTotal {
  day: string;
  /** Midnight of that day, local time. */
  start: number;
  minutes: number;
  sessions: number;
}

/** Focus per day for the last `days` days (today last), from sessions ending on each day. */
export function dailyTotals(sessions: readonly Session[], now: number, days = 7): DayTotal[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const totals: DayTotal[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const start = addDays(today.getTime(), -offset);
    totals.push({ day: dayKey(start), start, minutes: 0, sessions: 0 });
  }
  const byDay = new Map(totals.map((total) => [total.day, total]));
  for (const session of sessions) {
    const total = byDay.get(dayKey(session.end));
    if (!total) continue;
    total.minutes = Math.round((total.minutes + session.minutes) * 10) / 10;
    if (session.completed) total.sessions += 1;
  }
  return totals;
}

/** Days in a row, up to today (or yesterday, when today has none yet), with a completed session. */
export function streak(sessions: readonly Session[], now: number): number {
  const days = new Set(sessions.filter((session) => session.completed).map((s) => dayKey(s.end)));
  let cursor = now;
  if (!days.has(dayKey(cursor))) cursor = addDays(cursor, -1);
  let count = 0;
  while (days.has(dayKey(cursor))) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** Adds sessions by id (an instance that saw the same completion adds nothing), newest first. */
export function mergeSessions(
  existing: readonly Session[],
  added: readonly Session[],
  limit = 1000,
): Session[] {
  const byId = new Map(existing.map((session) => [session.id, session]));
  for (const session of added) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.end - a.end).slice(0, limit);
}
