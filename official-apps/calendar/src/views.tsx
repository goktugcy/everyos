import { EmptyState, useT } from "@everyos/app-ui";
import { Repeat, Search } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type MouseEvent } from "react";
import { addDays, dateOf, toWall, type LocalDate } from "./dates.ts";
import type { CalendarFormat } from "./format.ts";
import { layoutDay } from "./layout.ts";
import type { Occurrence } from "./recurrence.ts";

/** Pixels per hour in the day and week views. */
export const HOUR_HEIGHT = 48;
const MORE_AFTER = 3;

interface Shared {
  occurrences: Occurrence[];
  colors: ReadonlyMap<string, string>;
  today: LocalDate;
  format: CalendarFormat;
  onOpenEvent: (occurrence: Occurrence) => void;
}

const colorStyle = (colors: ReadonlyMap<string, string>, occurrence: Occurrence) =>
  ({ "--cal-color": colors.get(occurrence.event.calendarId) ?? "#2563eb" }) as CSSProperties;

function Chip({
  occurrence,
  colors,
  format,
  onOpen,
  continued,
}: {
  occurrence: Occurrence;
  colors: ReadonlyMap<string, string>;
  format: CalendarFormat;
  onOpen: () => void;
  continued?: boolean;
}) {
  const t = useT();
  const title = occurrence.event.title || t("event.untitled");
  return (
    <button
      type="button"
      className="cal-chip"
      data-all-day={occurrence.event.allDay || undefined}
      data-continued={continued || undefined}
      style={colorStyle(colors, occurrence)}
      title={`${title} · ${format.span(occurrence)}`}
      aria-label={`${title}, ${format.span(occurrence)}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {!occurrence.event.allDay ? (
        <span className="cal-chip-time">{format.time(occurrence.start)}</span>
      ) : null}
      <span className="cal-chip-title">{title}</span>
      {occurrence.event.rrule ? <Repeat size={11} aria-hidden /> : null}
    </button>
  );
}

const covers = (occurrence: Occurrence, day: LocalDate) =>
  occurrence.startDate <= day && day < occurrence.endDate;

export function MonthView({
  days,
  month,
  onOpenDay,
  onCreate,
  ...shared
}: Shared & {
  days: LocalDate[];
  month: string;
  onOpenDay: (date: LocalDate) => void;
  onCreate: (date: LocalDate) => void;
}) {
  const t = useT();
  const { occurrences, colors, today, format, onOpenEvent } = shared;
  return (
    <div className="cal-month" role="grid" aria-label={format.monthYear(`${month}-01`)}>
      <div className="cal-month-head" role="row">
        {days.slice(0, 7).map((day) => (
          <div key={day} role="columnheader" className="cal-weekday">
            {format.weekdayShort(day)}
          </div>
        ))}
      </div>
      {Array.from({ length: 6 }, (_, week) => (
        <div key={week} className="cal-month-row" role="row">
          {days.slice(week * 7, week * 7 + 7).map((day) => {
            const items = occurrences.filter((occurrence) => covers(occurrence, day));
            return (
              <div
                key={day}
                role="gridcell"
                className="cal-day"
                data-outside={day.slice(0, 7) !== month || undefined}
                data-today={day === today || undefined}
                onDoubleClick={() => onCreate(day)}
              >
                <button
                  type="button"
                  className="cal-day-number"
                  aria-label={format.fullDate(day)}
                  aria-current={day === today ? "date" : undefined}
                  onClick={() => onOpenDay(day)}
                >
                  {format.dayNumber(day)}
                </button>
                {items.slice(0, MORE_AFTER).map((occurrence) => (
                  <Chip
                    key={`${occurrence.event.id}|${occurrence.key}`}
                    occurrence={occurrence}
                    colors={colors}
                    format={format}
                    continued={occurrence.startDate < day}
                    onOpen={() => onOpenEvent(occurrence)}
                  />
                ))}
                {items.length > MORE_AFTER ? (
                  <button type="button" className="cal-more" onClick={() => onOpenDay(day)}>
                    {t("month.more", { count: items.length - MORE_AFTER })}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function TimeGrid({
  days,
  zone,
  now,
  onOpenDay,
  onCreate,
  ...shared
}: Shared & {
  days: LocalDate[];
  zone: string;
  now: number;
  onOpenDay: (date: LocalDate) => void;
  onCreate: (date: LocalDate, minutes: number | null) => void;
}) {
  const t = useT();
  const { occurrences, colors, today, format, onOpenEvent } = shared;
  const scroller = useRef<HTMLDivElement>(null);
  const nowWall = toWall(now, zone);
  const nowMinutes = Number(nowWall.slice(11, 13)) * 60 + Number(nowWall.slice(14, 16));

  // Start at the working day (or just before now, today).
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const showsToday = days.includes(dateOf(nowWall));
    element.scrollTop = Math.max(0, (showsToday ? nowMinutes / 60 - 1.5 : 7.5) * HOUR_HEIGHT);
    // Only when the shown days change.
  }, [days.join()]);

  const allDay = days.map((day) =>
    occurrences.filter((occurrence) => occurrence.event.allDay && covers(occurrence, day)),
  );
  const create = (day: LocalDate) => (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((event.clientY - box.top) / HOUR_HEIGHT) * 2) * 30;
    onCreate(day, Math.min(Math.max(0, minutes), 23 * 60 + 30));
  };

  return (
    <div className="cal-grid" style={{ "--days": days.length } as CSSProperties}>
      <div className="cal-grid-head">
        <div className="cal-gutter" />
        {days.map((day) => (
          <button
            key={day}
            type="button"
            className="cal-grid-day"
            data-today={day === today || undefined}
            aria-label={format.fullDate(day)}
            aria-current={day === today ? "date" : undefined}
            onClick={() => onOpenDay(day)}
          >
            <span>{format.weekdayShort(day)}</span>
            <strong>{format.dayNumber(day)}</strong>
          </button>
        ))}
      </div>
      <div className="cal-allday" aria-label={t("event.allDay")}>
        <div className="cal-gutter cal-allday-label">{t("event.allDay")}</div>
        {days.map((day, index) => (
          <div key={day} className="cal-allday-cell" onDoubleClick={() => onCreate(day, null)}>
            {allDay[index]!.map((occurrence) => (
              <Chip
                key={`${occurrence.event.id}|${occurrence.key}`}
                occurrence={occurrence}
                colors={colors}
                format={format}
                continued={occurrence.startDate < day}
                onOpen={() => onOpenEvent(occurrence)}
              />
            ))}
          </div>
        ))}
      </div>
      <div ref={scroller} className="cal-grid-scroll">
        <div className="cal-grid-body" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="cal-gutter cal-hours" aria-hidden>
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                {hour ? format.hour(hour) : ""}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div
              key={day}
              className="cal-column"
              data-today={day === today || undefined}
              aria-label={format.fullDate(day)}
              role="group"
              onClick={create(day)}
            >
              {layoutDay(occurrences, day, zone).map((placed) => (
                <button
                  key={`${placed.occurrence.event.id}|${placed.occurrence.key}`}
                  type="button"
                  className="cal-block"
                  style={{
                    ...colorStyle(colors, placed.occurrence),
                    top: (placed.top / 60) * HOUR_HEIGHT,
                    height: Math.max(18, (placed.height / 60) * HOUR_HEIGHT - 2),
                    left: `calc(${(placed.lane / placed.lanes) * 100}% + 2px)`,
                    width: `calc(${100 / placed.lanes}% - 4px)`,
                  }}
                  aria-label={`${placed.occurrence.event.title || t("event.untitled")}, ${format.span(placed.occurrence)}`}
                  onClick={() => onOpenEvent(placed.occurrence)}
                >
                  <strong>{placed.occurrence.event.title || t("event.untitled")}</strong>
                  <span>{format.span(placed.occurrence)}</span>
                  {placed.occurrence.event.location ? (
                    <span>{placed.occurrence.event.location}</span>
                  ) : null}
                </button>
              ))}
              {day === dateOf(nowWall) ? (
                <div
                  className="cal-now"
                  style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                  aria-label={t("grid.now", { time: format.time(now) })}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SearchResults({
  query,
  results,
  colors,
  format,
  onOpen,
}: {
  query: string;
  results: Occurrence[];
  colors: ReadonlyMap<string, string>;
  format: CalendarFormat;
  onOpen: (occurrence: Occurrence) => void;
}) {
  const t = useT();
  if (!results.length)
    return (
      <EmptyState
        icon={<Search size={28} aria-hidden />}
        title={t("search.none", { query })}
        text={t("search.noneText")}
      />
    );
  let lastDate = "";
  return (
    <ul className="cal-results" aria-label={t("search.results", { count: results.length })}>
      {results.map((occurrence) => {
        const heading = occurrence.startDate !== lastDate ? occurrence.startDate : null;
        lastDate = occurrence.startDate;
        return (
          <li key={`${occurrence.event.id}|${occurrence.key}`}>
            {heading ? <h3 className="cal-results-date">{format.fullDate(heading)}</h3> : null}
            <button
              type="button"
              className="cal-result"
              style={colorStyle(colors, occurrence)}
              onClick={() => onOpen(occurrence)}
            >
              <span className="cal-result-time">{format.span(occurrence)}</span>
              <strong>{occurrence.event.title || t("event.untitled")}</strong>
              {occurrence.event.location ? (
                <span className="eui-hint">{occurrence.event.location}</span>
              ) : null}
              {occurrence.event.rrule ? <Repeat size={12} aria-label={t("event.repeats")} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Days shown by a view around a date. */
export function viewDays(view: "day" | "week", date: LocalDate, weekStart: number): LocalDate[] {
  if (view === "day") return [date];
  const offset = (new Date(`${date}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7;
  const first = addDays(date, -offset);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}
