import { EmptyState, IconButton, LoadingState, useApp, useT } from "@everyos/app-ui";
import { CalendarDays, Maximize2 } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { addDays, dateOf, toWall } from "./dates.ts";
import { useCalendarFormat } from "./format.ts";
import { occurrencesIn } from "./recurrence.ts";
import { useCalendar, useReminders } from "./use-calendar.ts";

/** How far ahead the widget looks, and how many events it lists. */
const DAYS_AHEAD = 7;
const SHOWN = 8;

/** The next events of the coming week; opening one shows it in the Calendar. */
export function UpcomingWidget() {
  const app = useApp();
  const t = useT();
  const { events, calendars, zone } = useCalendar();
  const format = useCalendarFormat(zone);
  useReminders(events, calendars, zone, "widget", format.reminderBody);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = dateOf(toWall(now, zone));

  const upcoming = useMemo(() => {
    if (!events || !calendars) return null;
    const visible = new Set(
      calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id),
    );
    return occurrencesIn(
      events.filter((event) => visible.has(event.calendarId)),
      now,
      now + DAYS_AHEAD * 86_400_000,
      zone,
    )
      .filter((occurrence) => occurrence.end > now || occurrence.start >= now)
      .slice(0, SHOWN);
  }, [calendars, events, now, zone]);
  const colors = new Map((calendars ?? []).map((calendar) => [calendar.id, calendar.color]));

  const dayLabel = (date: string) =>
    date <= today
      ? t("widget.today")
      : date === addDays(today, 1)
        ? t("widget.tomorrow")
        : format.weekdayLong(date);

  let lastDay = "";
  return (
    <div className="cal-widget">
      <div className="cal-widget-head">
        <CalendarDays size={16} aria-hidden />
        <strong>{format.fullDate(today)}</strong>
        <IconButton
          size="sm"
          label={t("widget.open")}
          icon={<Maximize2 size={13} aria-hidden />}
          onClick={() => void app.window.open({ date: today })}
        />
      </div>
      {!upcoming ? (
        <LoadingState />
      ) : !upcoming.length ? (
        <EmptyState title={t("widget.empty")} />
      ) : (
        <ul className="cal-widget-list">
          {upcoming.map((occurrence) => {
            const day = occurrence.startDate < today ? today : occurrence.startDate;
            const heading = day !== lastDay ? dayLabel(day) : null;
            lastDay = day;
            return (
              <li key={`${occurrence.event.id}|${occurrence.key}`}>
                {heading ? <h3>{heading}</h3> : null}
                <button
                  type="button"
                  style={
                    {
                      "--cal-color": colors.get(occurrence.event.calendarId) ?? "#2563eb",
                    } as CSSProperties
                  }
                  onClick={() =>
                    void app.window.open({
                      date: occurrence.startDate,
                      eventId: occurrence.event.id,
                      key: occurrence.key,
                    })
                  }
                >
                  <span className="cal-widget-time">{format.span(occurrence)}</span>
                  <span className="cal-widget-title">
                    {occurrence.event.title || t("event.untitled")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
