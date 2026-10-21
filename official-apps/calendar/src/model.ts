import { isLocalDate, isLocalDateTime, isTimeZone, type LocalDate } from "./dates.ts";

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

export interface CalendarEvent {
  id: string;
  /** Kept through ICS export and import, so another calendar recognises the event. */
  uid: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  /** All-day: the first day. Timed: the wall time it starts, in `timeZone`. */
  start: LocalDate;
  /** All-day: the day after the last one. Timed: the wall time it ends, in `timeZone`. */
  end: LocalDate;
  /** The zone of a timed event's wall times; null means the viewer's own (floating). */
  timeZone: string | null;
  location: string;
  notes: string;
  /** An RFC 5545 recurrence rule without the `RRULE:` prefix, or null. */
  rrule: string | null;
  /** Starts (same form as `start`) of occurrences left out of the series. */
  exdates: string[];
  /** Minutes before the start; for all-day events, before 09:00 on the day. */
  reminders: number[];
  createdAt: number;
  updatedAt: number;
}

export const CALENDAR_COLORS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#ca8a04",
  "#db2777",
] as const;

export const MAX_TITLE = 300;
export const MAX_TEXT = 8000;
export const MAX_REMINDERS = 5;
/** Reminder choices, in minutes before the start (timed events). */
export const TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10_080] as const;
/** Reminder choices for all-day events: 09:00 on the day, a day or a week before. */
export const ALL_DAY_REMINDERS = [0, 1440, 2880, 10_080] as const;
/** All-day reminders are relative to this time of the day. */
export const ALL_DAY_REMINDER_TIME = "09:00";

export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(10))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const newUid = () => `${newId()}@everyos`;

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

/** A stored or imported event, checked field by field; null when it cannot be one. */
export function parseEvent(raw: unknown): CalendarEvent | null {
  const value = raw as Partial<CalendarEvent> | null;
  if (!value || typeof value.id !== "string" || typeof value.calendarId !== "string") return null;
  const allDay = value.allDay === true;
  const valid = allDay ? isLocalDate : isLocalDateTime;
  if (!valid(value.start) || !valid(value.end) || value.end < value.start) return null;
  if (allDay && value.end === value.start) return null;
  return {
    id: value.id,
    uid:
      typeof value.uid === "string" && value.uid ? value.uid.slice(0, 255) : `${value.id}@everyos`,
    calendarId: value.calendarId,
    title: text(value.title, MAX_TITLE),
    allDay,
    start: value.start,
    end: value.end,
    timeZone: !allDay && isTimeZone(value.timeZone) ? (value.timeZone as string) : null,
    location: text(value.location, MAX_TITLE),
    notes: text(value.notes, MAX_TEXT),
    rrule:
      typeof value.rrule === "string" && /^[A-Z0-9=;,:+-]{1,500}$/i.test(value.rrule)
        ? value.rrule
        : null,
    exdates: Array.isArray(value.exdates)
      ? value.exdates.filter((entry): entry is string => valid(entry)).slice(0, 1000)
      : [],
    reminders: Array.isArray(value.reminders)
      ? [
          ...new Set(
            value.reminders.filter(
              (entry) => Number.isInteger(entry) && entry >= 0 && entry <= 40_320,
            ),
          ),
        ]
          .sort((a, b) => a - b)
          .slice(0, MAX_REMINDERS)
      : [],
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

export function parseCalendar(raw: unknown): Calendar | null {
  const value = raw as Partial<Calendar> | null;
  if (!value || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name.slice(0, 80),
    color:
      typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
        ? value.color
        : CALENDAR_COLORS[0],
    visible: value.visible !== false,
  };
}
