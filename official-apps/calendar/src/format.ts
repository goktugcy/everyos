import { useI18n, useT } from "@everyos/app-ui";
import { useMemo } from "react";
import { addDays, dateOf, toWall, wallMs, type LocalDate } from "./dates.ts";
import type { CalendarEvent } from "./model.ts";
import type { Occurrence } from "./recurrence.ts";

/**
 * Dates and times in the person's language: instants in their zone, calendar dates as they are
 * (formatted as UTC, so a date never shifts by a zone).
 */
export function useCalendarFormat(zone: string) {
  const i18n = useI18n();
  const t = useT();
  return useMemo(() => {
    const onDate = (date: LocalDate, options: Intl.DateTimeFormatOptions) =>
      i18n.date(wallMs(date), { ...options, timeZone: "UTC" });
    const time = (ms: number) =>
      i18n.date(ms, { hour: "2-digit", minute: "2-digit", timeZone: zone });
    const format = {
      time,
      weekdayShort: (date: LocalDate) => onDate(date, { weekday: "short" }),
      weekdayLong: (date: LocalDate) => onDate(date, { weekday: "long" }),
      dayNumber: (date: LocalDate) => onDate(date, { day: "numeric" }),
      dayMonth: (date: LocalDate) => onDate(date, { day: "numeric", month: "short" }),
      fullDate: (date: LocalDate) => onDate(date, { dateStyle: "full" }),
      mediumDate: (date: LocalDate) => onDate(date, { dateStyle: "medium" }),
      monthYear: (date: LocalDate) => onDate(date, { month: "long", year: "numeric" }),
      monthName: (date: LocalDate) => onDate(date, { month: "long" }),
      hour: (hour: number) =>
        i18n.date(Date.UTC(2026, 0, 1, hour), {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        }),
      weekRange: (first: LocalDate) => {
        const last = addDays(first, 6);
        return first.slice(0, 7) === last.slice(0, 7)
          ? `${onDate(first, { day: "numeric" })} – ${onDate(last, { day: "numeric", month: "long", year: "numeric" })}`
          : `${onDate(first, { day: "numeric", month: "short" })} – ${onDate(last, { day: "numeric", month: "short", year: "numeric" })}`;
      },
      /** "09:00 – 10:30", "All day", or the days of a longer event. */
      span: (occurrence: Occurrence) => {
        if (occurrence.event.allDay) {
          const last = addDays(occurrence.endDate, -1);
          return last === occurrence.startDate
            ? t("event.allDay")
            : `${format.dayMonth(occurrence.startDate)} – ${format.dayMonth(last)}`;
        }
        const startDate = dateOf(toWall(occurrence.start, zone));
        const endDate = dateOf(toWall(Math.max(occurrence.start, occurrence.end - 1), zone));
        if (occurrence.end === occurrence.start) return time(occurrence.start);
        return startDate === endDate
          ? `${time(occurrence.start)} – ${time(occurrence.end)}`
          : `${format.dayMonth(startDate)} ${time(occurrence.start)} – ${format.dayMonth(endDate)} ${time(occurrence.end)}`;
      },
      /** A reminder's text: when the event starts. */
      reminderBody: (event: CalendarEvent, start: number) =>
        event.allDay
          ? t("reminders.allDayBody", { date: format.fullDate(dateOf(toWall(start, zone))) })
          : t("reminders.body", {
              time: time(start),
              date: format.fullDate(dateOf(toWall(start, zone))),
            }),
    };
    return format;
  }, [i18n, t, zone]);
}

export type CalendarFormat = ReturnType<typeof useCalendarFormat>;
