import { ALL_DAY_REMINDER_TIME, type CalendarEvent } from "./model.ts";
import { occurrences, type Occurrence } from "./recurrence.ts";
import { toInstant } from "./dates.ts";

/** How far ahead reminders are looked for (the longest reminder is a week before). */
const LOOK_AHEAD = 8 * 86_400_000;

export interface DueReminder {
  occurrence: Occurrence;
  minutes: number;
  /** Identifies the reminder for "sent once". */
  key: string;
}

/** When a reminder goes off: before the start, or before 09:00 on an all-day event's day. */
export function reminderTime(occurrence: Occurrence, minutes: number, zone: string): number {
  const base = occurrence.event.allDay
    ? toInstant(`${occurrence.startDate}T${ALL_DAY_REMINDER_TIME}`, zone)
    : occurrence.start;
  return base - minutes * 60_000;
}

/**
 * Reminders due now that were not sent yet: their time has come, and the event has not ended
 * (a reminder missed while EveryOS was closed still comes, but not for something already over).
 */
export function dueReminders(
  events: readonly CalendarEvent[],
  sent: ReadonlySet<string>,
  now: number,
  zone: string,
): DueReminder[] {
  const due: DueReminder[] = [];
  for (const event of events) {
    if (!event.reminders.length) continue;
    for (const occurrence of occurrences(event, now - 86_400_000, now + LOOK_AHEAD, zone)) {
      if (occurrence.end < now && occurrence.end !== occurrence.start) continue;
      for (const minutes of event.reminders) {
        const at = reminderTime(occurrence, minutes, zone);
        const key = `${event.id}|${occurrence.key}|${minutes}`;
        if (
          at <= now &&
          (occurrence.end >= now || occurrence.start >= now - 3_600_000) &&
          !sent.has(key)
        )
          due.push({ occurrence, minutes, key });
      }
    }
  }
  return due.sort((a, b) => a.occurrence.start - b.occurrence.start);
}
