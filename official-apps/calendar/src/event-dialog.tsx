import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Select,
  Switch,
  TextArea,
  TextField,
  useT,
} from "@everyos/app-ui";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  addDays,
  addMinutes,
  dateOf,
  join,
  timeOf,
  wallMs,
  weekday,
  type LocalDate,
} from "./dates.ts";
import type { CalendarFormat } from "./format.ts";
import {
  ALL_DAY_REMINDERS,
  MAX_REMINDERS,
  MAX_TEXT,
  MAX_TITLE,
  TIMED_REMINDERS,
  type Calendar,
  type CalendarEvent,
} from "./model.ts";
import {
  defaultRepeat,
  fromRule,
  MAX_COUNT,
  MAX_INTERVAL,
  toRule,
  weekdayPosition,
  type Freq,
  type Repeat,
} from "./recurrence.ts";

export type RepeatChoice =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "monthlyWeekday"
  | "yearly"
  | "custom"
  | "imported";

export interface Draft {
  title: string;
  allDay: boolean;
  startDate: LocalDate;
  startTime: string;
  /** The last day (inclusive) for all-day events. */
  endDate: LocalDate;
  endTime: string;
  repeat: RepeatChoice;
  custom: Repeat;
  /** A rule from another calendar the dialog cannot edit, kept unless changed. */
  importedRule: string | null;
  reminders: number[];
  calendarId: string;
  location: string;
  notes: string;
}

const WEEKDAYS_RULE = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";

function classify(rule: string | null, start: LocalDate): { choice: RepeatChoice; custom: Repeat } {
  const fallback = defaultRepeat("weekly", start);
  if (!rule) return { choice: "none", custom: fallback };
  const repeat = fromRule(rule, start);
  if (!repeat) return { choice: "imported", custom: fallback };
  const simple = repeat.interval === 1 && repeat.ends.kind === "never";
  if (simple && repeat.freq === "daily") return { choice: "daily", custom: repeat };
  if (simple && repeat.freq === "weekly" && rule.toUpperCase() === WEEKDAYS_RULE)
    return { choice: "weekdays", custom: repeat };
  if (
    simple &&
    repeat.freq === "weekly" &&
    repeat.byDay.length === 1 &&
    repeat.byDay[0] === weekday(start)
  )
    return { choice: "weekly", custom: repeat };
  if (simple && repeat.freq === "monthly")
    return { choice: repeat.monthly === "weekday" ? "monthlyWeekday" : "monthly", custom: repeat };
  if (simple && repeat.freq === "yearly") return { choice: "yearly", custom: repeat };
  return { choice: "custom", custom: repeat };
}

/** The dialog's starting values for an event, shown at one of its occurrences (`key`). */
export function draftOf(event: CalendarEvent, key: string): Draft {
  const start = key;
  const span = wallMs(event.end) - wallMs(event.start);
  const startDate = dateOf(start);
  const { choice, custom } = classify(event.rrule, dateOf(event.start));
  if (event.allDay)
    return {
      title: event.title,
      allDay: true,
      startDate,
      startTime: "09:00",
      endDate: addDays(dateOf(start), Math.round(span / 86_400_000) - 1),
      endTime: "10:00",
      repeat: choice,
      custom,
      importedRule: choice === "imported" ? event.rrule : null,
      reminders: event.reminders,
      calendarId: event.calendarId,
      location: event.location,
      notes: event.notes,
    };
  const end = addMinutes(start, Math.round(span / 60_000));
  return {
    title: event.title,
    allDay: false,
    startDate,
    startTime: timeOf(start),
    endDate: dateOf(end),
    endTime: timeOf(end),
    repeat: choice,
    custom,
    importedRule: choice === "imported" ? event.rrule : null,
    reminders: event.reminders,
    calendarId: event.calendarId,
    location: event.location,
    notes: event.notes,
  };
}

export function ruleOf(draft: Draft): string | null {
  const start = draft.startDate;
  const simple = (freq: Freq, monthly: Repeat["monthly"] = "day") =>
    toRule({ ...defaultRepeat(freq, start), monthly }, start);
  switch (draft.repeat) {
    case "none":
      return null;
    case "daily":
      return simple("daily");
    case "weekdays":
      return WEEKDAYS_RULE;
    case "weekly":
      return simple("weekly");
    case "monthly":
      return simple("monthly");
    case "monthlyWeekday":
      return simple("monthly", "weekday");
    case "yearly":
      return simple("yearly");
    case "custom":
      return toRule(draft.custom, start);
    case "imported":
      return draft.importedRule;
  }
}

export type DraftProblem = "endBeforeStart" | "untilBeforeStart";

export function problemOf(draft: Draft): DraftProblem | null {
  if (
    draft.allDay
      ? draft.endDate < draft.startDate
      : join(draft.endDate, draft.endTime) < join(draft.startDate, draft.startTime)
  )
    return "endBeforeStart";
  if (
    draft.repeat === "custom" &&
    draft.custom.ends.kind === "until" &&
    draft.custom.ends.date < draft.startDate
  )
    return "untilBeforeStart";
  return null;
}

/** The event the dialog describes (`base` holds what the dialog does not show). */
export function eventOf(draft: Draft, base: CalendarEvent): CalendarEvent {
  return {
    ...base,
    title: draft.title.trim().slice(0, MAX_TITLE),
    allDay: draft.allDay,
    start: draft.allDay ? draft.startDate : join(draft.startDate, draft.startTime),
    end: draft.allDay ? addDays(draft.endDate, 1) : join(draft.endDate, draft.endTime),
    timeZone: draft.allDay ? null : base.timeZone,
    rrule: ruleOf(draft),
    reminders: [...new Set(draft.reminders)].sort((a, b) => a - b).slice(0, MAX_REMINDERS),
    calendarId: draft.calendarId,
    location: draft.location.trim().slice(0, MAX_TITLE),
    notes: draft.notes.slice(0, MAX_TEXT),
  };
}

export function useReminderLabel() {
  const t = useT();
  return (minutes: number, allDay: boolean) => {
    if (allDay) {
      if (minutes === 0) return t("reminders.onDay");
      if (minutes % 10_080 === 0) return t("reminders.weeksBeforeAt", { count: minutes / 10_080 });
      if (minutes % 1440 === 0) return t("reminders.daysBeforeAt", { count: minutes / 1440 });
    }
    if (minutes === 0) return t("reminders.atStart");
    if (minutes % 10_080 === 0) return t("reminders.weeks", { count: minutes / 10_080 });
    if (minutes % 1440 === 0) return t("reminders.days", { count: minutes / 1440 });
    if (minutes % 60 === 0) return t("reminders.hours", { count: minutes / 60 });
    return t("reminders.minutes", { count: minutes });
  };
}

export function EventDialog({
  open,
  isNew,
  draft,
  onDraft,
  calendars,
  zoneNote,
  format,
  weekStart,
  onSave,
  onDelete,
  onClose,
}: {
  open: boolean;
  isNew: boolean;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  calendars: Calendar[];
  /** Set when the event's times are in another zone than the person's. */
  zoneNote: string | null;
  format: CalendarFormat;
  weekStart: number;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const reminderLabel = useReminderLabel();
  const [touched, setTouched] = useState(false);
  const problem = problemOf(draft);
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });
  const reminderChoices = (current: number) =>
    [...new Set([...(draft.allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS), current])].sort(
      (a, b) => a - b,
    );
  const weekOrder = Array.from({ length: 7 }, (_, index) => (weekStart + index) % 7);
  const sampleDay = (day: number) => addDays("2026-10-18", day); // 18 October 2026 is a Sunday.
  const custom = draft.custom;
  const setCustom = (patch: Partial<Repeat>) => set({ custom: { ...custom, ...patch } });

  return (
    <Dialog
      open={open}
      title={isNew ? t("event.newTitle") : t("event.editTitle")}
      onClose={onClose}
      actions={
        <>
          {!isNew ? (
            <Button variant="danger" icon={<Trash2 size={14} aria-hidden />} onClick={onDelete}>
              {t("event.delete")}
            </Button>
          ) : null}
          <span className="cal-spacer" />
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              setTouched(true);
              if (!problem) onSave();
            }}
          >
            {t("ui.save")}
          </Button>
        </>
      }
    >
      <form
        className="cal-form"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!problem) onSave();
        }}
      >
        <TextField
          label={t("event.title")}
          value={draft.title}
          maxLength={MAX_TITLE}
          autoFocus
          placeholder={t("event.titlePlaceholder")}
          onChange={(event) => set({ title: event.target.value })}
        />
        <label className="cal-inline">
          <Switch
            label={t("event.allDay")}
            checked={draft.allDay}
            onChange={(allDay) =>
              set({
                allDay,
                reminders: draft.reminders.filter((minutes) =>
                  (allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS).includes(minutes as never),
                ),
              })
            }
          />
          <span aria-hidden>{t("event.allDay")}</span>
        </label>
        <div className="cal-when">
          <TextField
            label={t("event.startDate")}
            type="date"
            value={draft.startDate}
            required
            onChange={(event) => {
              const startDate = event.target.value;
              if (!startDate) return;
              // Moving the start moves the end with it.
              const shift = Math.round((wallMs(startDate) - wallMs(draft.startDate)) / 86_400_000);
              set({ startDate, endDate: addDays(draft.endDate, shift) });
            }}
          />
          {!draft.allDay ? (
            <TextField
              label={t("event.startTime")}
              type="time"
              value={draft.startTime}
              required
              onChange={(event) => {
                const startTime = event.target.value;
                if (!startTime) return;
                const before = join(draft.startDate, draft.startTime);
                const length =
                  (wallMs(join(draft.endDate, draft.endTime)) - wallMs(before)) / 60_000;
                const end = addMinutes(join(draft.startDate, startTime), Math.max(0, length));
                set({ startTime, endDate: dateOf(end), endTime: timeOf(end) });
              }}
            />
          ) : null}
          <TextField
            label={draft.allDay ? t("event.lastDay") : t("event.endDate")}
            type="date"
            value={draft.endDate}
            required
            onChange={(event) => event.target.value && set({ endDate: event.target.value })}
          />
          {!draft.allDay ? (
            <TextField
              label={t("event.endTime")}
              type="time"
              value={draft.endTime}
              required
              onChange={(event) => event.target.value && set({ endTime: event.target.value })}
            />
          ) : null}
        </div>
        {touched && problem ? (
          <p className="eui-error-text" role="alert">
            {t(`problems.${problem}`)}
          </p>
        ) : null}
        {zoneNote && !draft.allDay ? <p className="eui-hint">{zoneNote}</p> : null}
        <Select<RepeatChoice>
          label={t("repeat.label")}
          value={draft.repeat}
          onChange={(repeat) => set({ repeat })}
          options={[
            { value: "none", label: t("repeat.none") },
            { value: "daily", label: t("repeat.daily") },
            { value: "weekdays", label: t("repeat.weekdays") },
            {
              value: "weekly",
              label: t("repeat.weekly", { day: format.weekdayLong(draft.startDate) }),
            },
            {
              value: "monthly",
              label: t("repeat.monthly", { day: Number(draft.startDate.slice(8, 10)) }),
            },
            {
              value: "monthlyWeekday",
              label: t("repeat.monthlyWeekday", {
                nth: t(`repeat.nth.${weekdayPosition(draft.startDate)}`),
                day: format.weekdayLong(draft.startDate),
              }),
            },
            {
              value: "yearly",
              label: t("repeat.yearly", { date: format.dayMonth(draft.startDate) }),
            },
            { value: "custom", label: t("repeat.custom") },
            ...(draft.importedRule
              ? [{ value: "imported" as const, label: t("repeat.imported") }]
              : []),
          ]}
        />
        {draft.repeat === "custom" ? (
          <fieldset className="cal-custom">
            <legend>{t("repeat.custom")}</legend>
            <div className="cal-inline">
              <TextField
                label={t("repeat.every")}
                type="number"
                min={1}
                max={MAX_INTERVAL}
                value={String(custom.interval)}
                onChange={(event) =>
                  setCustom({
                    interval: Math.min(MAX_INTERVAL, Math.max(1, Number(event.target.value) || 1)),
                  })
                }
              />
              <Select<Freq>
                label={t("repeat.unit")}
                value={custom.freq}
                onChange={(freq) => setCustom({ freq })}
                options={(["daily", "weekly", "monthly", "yearly"] as const).map((freq) => ({
                  value: freq,
                  label: t(`repeat.units.${freq}`, { count: custom.interval }),
                }))}
              />
            </div>
            {custom.freq === "weekly" ? (
              <div className="cal-weekdays" role="group" aria-label={t("repeat.onDays")}>
                {weekOrder.map((day) => (
                  <Checkbox
                    key={day}
                    label={format.weekdayShort(sampleDay(day))}
                    checked={custom.byDay.includes(day)}
                    onChange={(checked) =>
                      setCustom({
                        byDay: checked
                          ? [...custom.byDay, day]
                          : custom.byDay.filter((entry) => entry !== day).length
                            ? custom.byDay.filter((entry) => entry !== day)
                            : custom.byDay,
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {custom.freq === "monthly" ? (
              <Select<Repeat["monthly"]>
                label={t("repeat.monthlyOn")}
                value={custom.monthly}
                onChange={(monthly) => setCustom({ monthly })}
                options={[
                  {
                    value: "day",
                    label: t("repeat.onDay", { day: Number(draft.startDate.slice(8, 10)) }),
                  },
                  {
                    value: "weekday",
                    label: t("repeat.onWeekday", {
                      nth: t(`repeat.nth.${weekdayPosition(draft.startDate)}`),
                      day: format.weekdayLong(draft.startDate),
                    }),
                  },
                ]}
              />
            ) : null}
            <div className="cal-inline">
              <Select<Repeat["ends"]["kind"]>
                label={t("repeat.ends")}
                value={custom.ends.kind}
                onChange={(kind) =>
                  setCustom({
                    ends:
                      kind === "until"
                        ? { kind, date: addDays(draft.startDate, 90) }
                        : kind === "count"
                          ? { kind, count: 10 }
                          : { kind },
                  })
                }
                options={[
                  { value: "never", label: t("repeat.never") },
                  { value: "until", label: t("repeat.until") },
                  { value: "count", label: t("repeat.after") },
                ]}
              />
              {custom.ends.kind === "until" ? (
                <TextField
                  label={t("repeat.untilDate")}
                  type="date"
                  value={custom.ends.date}
                  onChange={(event) =>
                    event.target.value &&
                    setCustom({ ends: { kind: "until", date: event.target.value } })
                  }
                />
              ) : null}
              {custom.ends.kind === "count" ? (
                <TextField
                  label={t("repeat.times")}
                  type="number"
                  min={1}
                  max={MAX_COUNT}
                  value={String(custom.ends.count)}
                  onChange={(event) =>
                    setCustom({
                      ends: {
                        kind: "count",
                        count: Math.min(MAX_COUNT, Math.max(1, Number(event.target.value) || 1)),
                      },
                    })
                  }
                />
              ) : null}
            </div>
          </fieldset>
        ) : null}
        <fieldset className="cal-reminders">
          <legend>{t("reminders.label")}</legend>
          {draft.reminders.map((minutes, index) => (
            <div key={index} className="cal-inline">
              <Select
                label={t("reminders.label")}
                hideLabel
                value={String(minutes)}
                onChange={(value) =>
                  set({
                    reminders: draft.reminders.map((entry, at) =>
                      at === index ? Number(value) : entry,
                    ),
                  })
                }
                options={reminderChoices(minutes).map((choice) => ({
                  value: String(choice),
                  label: reminderLabel(choice, draft.allDay),
                }))}
              />
              <IconButton
                size="sm"
                label={t("reminders.remove", { label: reminderLabel(minutes, draft.allDay) })}
                icon={<X size={14} aria-hidden />}
                onClick={() => set({ reminders: draft.reminders.filter((_, at) => at !== index) })}
              />
            </div>
          ))}
          {draft.reminders.length < MAX_REMINDERS ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={14} aria-hidden />}
              onClick={() =>
                set({
                  reminders: [
                    ...draft.reminders,
                    (draft.allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS).find(
                      (choice) =>
                        !draft.reminders.includes(choice) && (draft.allDay || choice >= 10),
                    ) ?? 0,
                  ],
                })
              }
            >
              {t("reminders.add")}
            </Button>
          ) : null}
        </fieldset>
        {calendars.length > 1 ? (
          <Select
            label={t("event.calendar")}
            value={draft.calendarId}
            onChange={(calendarId) => set({ calendarId })}
            options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))}
          />
        ) : null}
        <TextField
          label={t("event.location")}
          value={draft.location}
          maxLength={MAX_TITLE}
          onChange={(event) => set({ location: event.target.value })}
        />
        <TextArea
          label={t("event.notes")}
          value={draft.notes}
          maxLength={MAX_TEXT}
          rows={3}
          onChange={(event) => set({ notes: event.target.value })}
        />
      </form>
    </Dialog>
  );
}

export type Scope = "one" | "following" | "all";

/** Which occurrences of a repeating event a change or a deletion is for. */
export function ScopeDialog({
  open,
  action,
  onChoose,
  onClose,
}: {
  open: boolean;
  action: "save" | "delete";
  onChoose: (scope: Scope) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<Scope>("one");
  return (
    <Dialog
      open={open}
      title={action === "save" ? t("scope.saveTitle") : t("scope.deleteTitle")}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button
            variant={action === "delete" ? "danger" : "primary"}
            onClick={() => onChoose(scope)}
          >
            {action === "save" ? t("ui.save") : t("event.delete")}
          </Button>
        </>
      }
    >
      <div className="cal-scopes" role="radiogroup" aria-label={t("scope.label")}>
        {(["one", "following", "all"] as const).map((value) => (
          <label key={value} className="cal-inline">
            <input
              type="radio"
              name="scope"
              checked={scope === value}
              onChange={() => setScope(value)}
            />
            <span>{t(`scope.${value}`)}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
