import {
  Button,
  Dialog,
  IconButton,
  LoadingState,
  Select,
  Spacer,
  Tabs,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  openTextFile,
  saveTextFile,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  addDays,
  addMinutes,
  addMonths,
  dateOf,
  isLocalDate,
  join,
  localeWeekStart,
  monthGrid,
  toInstant,
  toWall,
  wallMs,
  type LocalDate,
} from "./dates.ts";
import {
  draftOf,
  EventDialog,
  eventOf,
  ruleOf,
  ScopeDialog,
  type Draft,
  type Scope,
} from "./event-dialog.tsx";
import { useCalendarFormat } from "./format.ts";
import { MAX_ICS_BYTES, parseIcs, toIcs, type Imported } from "./ics.ts";
import { CALENDAR_COLORS, newId, newUid, type Calendar, type CalendarEvent } from "./model.ts";
import {
  endSeriesBefore,
  occurrences,
  occurrencesIn,
  ruleFrom,
  type Occurrence,
} from "./recurrence.ts";
import { useCalendar, useReminders } from "./use-calendar.ts";
import { MonthView, SearchResults, TimeGrid, viewDays } from "./views.tsx";

export type View = "day" | "week" | "month";

interface Settings {
  weekStart: "auto" | "0" | "1" | "6";
}

interface Editing {
  /** The stored event (for a repeating one, its series). */
  event: CalendarEvent;
  /** The occurrence being edited (its start in the event's terms). */
  key: string;
  isNew: boolean;
  draft: Draft;
  initial: Draft;
}

/** Where a widget or a notification asked to open the calendar. */
function requested(
  state: unknown,
): { date: LocalDate; eventId: string | null; key: string | null } | null {
  const value = state as { date?: unknown; eventId?: unknown; key?: unknown } | null;
  if (!value || !isLocalDate(value.date)) return null;
  return {
    date: value.date,
    eventId: typeof value.eventId === "string" ? value.eventId : null,
    key: typeof value.key === "string" ? value.key : null,
  };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function CalendarApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(760);
  const data = useCalendar();
  const { events, calendars, zone, save, remove, saveCalendars, fail } = data;
  const format = useCalendarFormat(zone);
  const [view, setView] = usePersistentState<View>("view", "month");
  const [settings, setSettings] = usePersistentState<Settings>("settings", { weekStart: "auto" });
  const [sidebar, setSidebar] = usePersistentState("sidebar", true);
  const [now, setNow] = useState(() => Date.now());
  const today = dateOf(toWall(now, zone));
  const initial = requested(app.window.initialState);
  const [date, setDate] = useState<LocalDate>(initial?.date ?? today);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [scopeFor, setScopeFor] = useState<"save" | "delete" | null>(null);
  const [calendarDialog, setCalendarDialog] = useState<Calendar | "new" | null>(null);
  const [calendarName, setCalendarName] = useState("");
  const [importing, setImporting] = useState<{
    imported: Imported;
    fileName: string;
    target: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pendingOpen = useRef(initial);
  const searchInput = useRef<HTMLInputElement | null>(null);

  const weekStart =
    settings.weekStart === "auto" ? localeWeekStart(i18n.tag) : Number(settings.weekStart);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useReminders(events, calendars, zone, "window", format.reminderBody);

  const visibleCalendars = useMemo(
    () =>
      new Set(
        (calendars ?? []).filter((calendar) => calendar.visible).map((calendar) => calendar.id),
      ),
    [calendars],
  );
  const colors = useMemo(
    () => new Map((calendars ?? []).map((calendar) => [calendar.id, calendar.color])),
    [calendars],
  );
  const shownEvents = useMemo(
    () => (events ?? []).filter((event) => visibleCalendars.has(event.calendarId)),
    [events, visibleCalendars],
  );

  const days = view === "month" ? monthGrid(date, weekStart) : viewDays(view, date, weekStart);
  const rangeStart = toInstant(days[0]!, zone);
  const rangeEnd = toInstant(addDays(days.at(-1)!, 1), zone);
  const shown = useMemo(
    () => occurrencesIn(shownEvents, rangeStart, rangeEnd, zone),
    [shownEvents, rangeStart, rangeEnd, zone],
  );

  const results = useMemo(() => {
    const words = query.trim().toLocaleLowerCase(i18n.tag);
    if (!words) return [];
    const yearsAround = 2 * 366 * 86_400_000;
    return (events ?? [])
      .filter((event) =>
        `${event.title}\n${event.location}\n${event.notes}`
          .toLocaleLowerCase(i18n.tag)
          .includes(words),
      )
      .map((event) => {
        const found = occurrences(event, now - yearsAround, now + yearsAround, zone);
        return found.find((occurrence) => occurrence.end >= now) ?? found.at(-1);
      })
      .filter((occurrence): occurrence is Occurrence => occurrence !== undefined)
      .sort((a, b) => a.start - b.start);
  }, [events, i18n.tag, now, query, zone]);

  const openOccurrence = (occurrence: Occurrence) => {
    const draft = draftOf(occurrence.event, occurrence.key);
    setEditing({
      event: occurrence.event,
      key: occurrence.key,
      isNew: false,
      draft,
      initial: draft,
    });
  };

  // Opened from the widget (or again with new state): the day, and the event if one was asked for.
  useEffect(() => {
    const target = pendingOpen.current;
    if (!events || !target) return;
    pendingOpen.current = null;
    setDate(target.date);
    setQuery("");
    const event = target.eventId ? events.find((entry) => entry.id === target.eventId) : undefined;
    if (!event) return;
    const found = occurrences(
      event,
      toInstant(addDays(target.date, -1), zone),
      toInstant(addDays(target.date, 2), zone),
      zone,
    );
    const occurrence = found.find((entry) => entry.key === target.key) ?? found[0];
    if (occurrence) openOccurrence(occurrence);
  }, [events]);
  const { refresh } = data;
  useEffect(
    () =>
      app.window.onOpened((state) => {
        pendingOpen.current = requested(state);
        // Read again (the widget may have just changed something), then show it.
        void refresh();
      }),
    [app, refresh],
  );

  const newEvent = (day: LocalDate, minutes: number | null) => {
    const calendarId =
      (calendars ?? []).find((calendar) => calendar.visible)?.id ??
      calendars?.[0]?.id ??
      "personal";
    const allDay = minutes === null;
    const start = allDay ? day : addMinutes(join(day, "00:00"), minutes);
    const event: CalendarEvent = {
      id: newId(),
      uid: newUid(),
      calendarId,
      title: "",
      allDay,
      start,
      end: allDay ? addDays(day, 1) : addMinutes(start, 60),
      timeZone: allDay ? null : zone,
      location: "",
      notes: "",
      rrule: null,
      exdates: [],
      reminders: allDay ? [] : [10],
      createdAt: 0,
      updatedAt: 0,
    };
    const draft = draftOf(event, event.start);
    setEditing({ event, key: event.start, isNew: true, draft, initial: draft });
  };

  const newEventNow = () => {
    const nextHour = Math.min(23 * 60, (Number(toWall(now, zone).slice(11, 13)) + 1) * 60);
    newEvent(date, date === today ? nextHour : 9 * 60);
  };

  const close = () => {
    setEditing(null);
    setScopeFor(null);
  };

  const commit = async (scope?: Scope) => {
    if (!editing) return;
    const { event: original, key, draft, isNew, initial: before } = editing;
    const edited = eventOf(draft, original);
    if (isNew || !original.rrule) {
      if (await save(edited)) close();
      return;
    }
    if (!scope) return setScopeFor("save");
    // The rule as it was, unless the person changed the repeat or the start day.
    const sameRule = ruleOf(draft) === ruleOf(before) && draft.startDate === before.startDate;
    const rule = sameRule ? original.rrule : edited.rrule;
    const sameTime = edited.start.slice(10) === key.slice(10) && edited.allDay === original.allDay;
    let changed: CalendarEvent[];
    if (scope === "one") {
      changed = [
        { ...original, exdates: [...original.exdates, key] },
        { ...edited, id: newId(), uid: newUid(), rrule: null, exdates: [], createdAt: 0 },
      ];
    } else if (scope === "following" && key !== original.start) {
      const head = endSeriesBefore(original, key)!;
      changed = [
        head,
        {
          ...edited,
          id: newId(),
          uid: newUid(),
          rrule: sameRule ? ruleFrom(original, key) : edited.rrule,
          exdates: sameTime ? original.exdates.filter((skip) => wallMs(skip) > wallMs(key)) : [],
          createdAt: 0,
        },
      ];
    } else {
      // The whole series moves by as much as this occurrence moved.
      const delta = edited.allDay === original.allDay ? wallMs(edited.start) - wallMs(key) : 0;
      const shift = (value: string) => {
        const moved = addMinutes(original.allDay ? join(value, "00:00") : value, delta / 60_000);
        return edited.allDay ? dateOf(moved) : moved;
      };
      const start = edited.allDay === original.allDay ? shift(original.start) : edited.start;
      const length = wallMs(edited.end) - wallMs(edited.start);
      const end = edited.allDay
        ? addDays(start, Math.round(length / 86_400_000))
        : addMinutes(start, length / 60_000);
      changed = [
        {
          ...edited,
          start,
          end,
          rrule: rule,
          exdates: edited.allDay === original.allDay ? original.exdates.map(shift) : [],
        },
      ];
    }
    if (await save(...changed)) close();
  };

  const destroy = async (scope?: Scope) => {
    if (!editing) return;
    const { event, key } = editing;
    if (!event.rrule) {
      if (
        await app.dialogs.confirm(
          t("event.deleteTitle", { title: event.title || t("event.untitled") }),
          t("ui.deleteBody"),
          { confirm: t("event.delete"), destructive: true },
        )
      )
        if (await remove(event.id)) close();
      return;
    }
    if (!scope) return setScopeFor("delete");
    const ok =
      scope === "one"
        ? await save({ ...event, exdates: [...event.exdates, key] })
        : scope === "following" && endSeriesBefore(event, key)
          ? await save(endSeriesBefore(event, key)!)
          : await remove(event.id);
    if (ok) close();
  };

  const step = (direction: 1 | -1) =>
    setDate((current) =>
      view === "month"
        ? addMonths(current, direction)
        : addDays(current, direction * (view === "week" ? 7 : 1)),
    );

  // Keys that do not get in the way of typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || editing || isTyping(event.target))
        return;
      const actions: Record<string, () => void> = {
        t: () => setDate(today),
        d: () => setView("day"),
        w: () => setView("week"),
        m: () => setView("month"),
        n: newEventNow,
        "/": () => searchInput.current?.focus(),
        ArrowLeft: () => step(-1),
        ArrowRight: () => step(1),
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const importFile = async () => {
    try {
      const file = await openTextFile(app, {
        accept: [".ics", ".ical", ".ifb", ".icalendar"],
        maxBytes: MAX_ICS_BYTES,
      });
      if (!file) return;
      const imported = parseIcs(file.text, { calendarId: "", viewerZone: zone, now: Date.now() });
      setImporting({ imported, fileName: file.name.replace(/\.[^.]*$/, ""), target: "new" });
    } catch (caught) {
      toast(
        caught instanceof SyntaxError
          ? t("ics.invalid")
          : errorMessage(t, caught) || t("ics.invalid"),
        "danger",
      );
    }
  };

  const finishImport = async () => {
    if (!importing || !calendars) return;
    let calendarId = importing.target;
    let name = calendars.find((calendar) => calendar.id === calendarId)?.name ?? "";
    if (calendarId === "new") {
      name =
        (importing.imported.name ?? importing.fileName).slice(0, 80) || t("calendars.imported");
      const calendar = await data.store.addCalendar(name, calendars).catch((caught: unknown) => {
        fail(caught);
        return null;
      });
      if (!calendar) return;
      calendarId = calendar.id;
      await data.refresh();
    }
    // Importing again updates the events it brought last time (same UID).
    const existing = new Map(
      (events ?? [])
        .filter((event) => event.calendarId === calendarId)
        .map((event) => [event.uid, event]),
    );
    const incoming = importing.imported.events.map((event) => ({
      ...event,
      calendarId,
      id: existing.get(event.uid)?.id ?? event.id,
    }));
    if (await save(...incoming)) {
      toast(t("ics.imported", { count: incoming.length, name }));
      if (importing.imported.unknownZones)
        toast(t("ics.unknownZones", { count: importing.imported.unknownZones }));
      setImporting(null);
    }
  };

  const exportCalendar = async (calendar: Calendar) => {
    try {
      const text = toIcs(
        (events ?? []).filter((event) => event.calendarId === calendar.id),
        calendar.name,
        Date.now(),
      );
      if (await saveTextFile(app, `${calendar.name}.ics`, text, { accept: [".ics"] }))
        toast(t("ui.exported"));
    } catch (caught) {
      fail(caught);
    }
  };

  const deleteCalendar = async (calendar: Calendar) => {
    if (!calendars || calendars.length < 2) return;
    const count = (events ?? []).filter((event) => event.calendarId === calendar.id).length;
    if (
      !(await app.dialogs.confirm(
        t("calendars.deleteTitle", { name: calendar.name }),
        t("calendars.deleteBody", { count }),
        { confirm: t("calendars.delete"), destructive: true },
      ))
    )
      return;
    try {
      await data.store.removeCalendar(calendar.id, calendars);
      await data.refresh();
    } catch (caught) {
      fail(caught);
    }
  };

  if (!events || !calendars) return <LoadingState />;

  const title = query.trim()
    ? t("search.title", { query: query.trim() })
    : view === "month"
      ? format.monthYear(date)
      : view === "week"
        ? format.weekRange(days[0]!)
        : format.fullDate(date);

  const editingCalendarZone = editing?.event.timeZone;

  return (
    <div className="cal-app" data-narrow={narrow || undefined}>
      <Toolbar label={t("app.name")}>
        <IconButton
          label={sidebar ? t("sidebar.hide") : t("sidebar.show")}
          icon={<PanelLeft size={16} aria-hidden />}
          aria-pressed={sidebar}
          onClick={() => setSidebar((open) => !open)}
        />
        <Button size="sm" onClick={() => setDate(today)}>
          {t("nav.today")}
        </Button>
        <IconButton
          label={t(`nav.previous.${view}`)}
          icon={<ChevronLeft size={16} aria-hidden />}
          onClick={() => step(-1)}
        />
        <IconButton
          label={t(`nav.next.${view}`)}
          icon={<ChevronRight size={16} aria-hidden />}
          onClick={() => step(1)}
        />
        <ToolbarTitle>
          <span aria-live="polite">{title}</span>
        </ToolbarTitle>
        <Spacer />
        <div className="cal-search" role="search">
          <Search size={14} aria-hidden />
          <input
            ref={searchInput}
            className="eui-input"
            type="search"
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
        </div>
        {!narrow ? (
          <Tabs<View>
            label={t("views.label")}
            value={view}
            onChange={(next) => {
              setView(next);
              setQuery("");
            }}
            tabs={(["day", "week", "month"] as const).map((value) => ({
              value,
              label: t(`views.${value}`),
            }))}
          />
        ) : (
          <Select<View>
            label={t("views.label")}
            hideLabel
            value={view}
            onChange={setView}
            options={(["day", "week", "month"] as const).map((value) => ({
              value,
              label: t(`views.${value}`),
            }))}
          />
        )}
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={15} aria-hidden />}
          onClick={newEventNow}
        >
          {t("event.new")}
        </Button>
      </Toolbar>
      <div className="cal-body" data-sidebar={sidebar || undefined}>
        {sidebar ? (
          <aside className="cal-sidebar" aria-label={t("calendars.label")}>
            <TextField
              label={t("nav.goTo")}
              type="date"
              value={date}
              onChange={(event) => isLocalDate(event.target.value) && setDate(event.target.value)}
            />
            <h2>{t("calendars.label")}</h2>
            <ul className="cal-calendars">
              {calendars.map((calendar) => (
                <li key={calendar.id}>
                  <label
                    className="cal-calendar"
                    style={{ "--cal-color": calendar.color } as CSSProperties}
                  >
                    <input
                      type="checkbox"
                      checked={calendar.visible}
                      onChange={(event) =>
                        void saveCalendars(
                          calendars.map((entry) =>
                            entry.id === calendar.id
                              ? { ...entry, visible: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                    />
                    <span>{calendar.name}</span>
                  </label>
                  <IconButton
                    size="sm"
                    label={t("calendars.edit", { name: calendar.name })}
                    icon={<Pencil size={13} aria-hidden />}
                    onClick={() => {
                      setCalendarName(calendar.name);
                      setCalendarDialog(calendar);
                    }}
                  />
                  <IconButton
                    size="sm"
                    label={t("calendars.export", { name: calendar.name })}
                    icon={<Download size={13} aria-hidden />}
                    onClick={() => void exportCalendar(calendar)}
                  />
                  {calendars.length > 1 ? (
                    <IconButton
                      size="sm"
                      label={t("calendars.deleteNamed", { name: calendar.name })}
                      icon={<Trash2 size={13} aria-hidden />}
                      onClick={() => void deleteCalendar(calendar)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={14} aria-hidden />}
              onClick={() => {
                setCalendarName("");
                setCalendarDialog("new");
              }}
            >
              {t("calendars.add")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<FileUp size={14} aria-hidden />}
              onClick={() => void importFile()}
            >
              {t("ics.import")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Settings2 size={14} aria-hidden />}
              onClick={() => setSettingsOpen(true)}
            >
              {t("settings.title")}
            </Button>
            <p className="eui-hint cal-keys">{t("nav.keys")}</p>
          </aside>
        ) : null}
        <main className="cal-main">
          {query.trim() ? (
            <SearchResults
              query={query.trim()}
              results={results}
              colors={colors}
              format={format}
              onOpen={(occurrence) => {
                setDate(occurrence.startDate);
                openOccurrence(occurrence);
              }}
            />
          ) : view === "month" ? (
            <MonthView
              days={days}
              month={date.slice(0, 7)}
              occurrences={shown}
              colors={colors}
              today={today}
              format={format}
              onOpenEvent={openOccurrence}
              onOpenDay={(day) => {
                setDate(day);
                setView("day");
              }}
              onCreate={(day) => newEvent(day, 9 * 60)}
            />
          ) : (
            <TimeGrid
              days={days}
              zone={zone}
              now={now}
              occurrences={shown}
              colors={colors}
              today={today}
              format={format}
              onOpenEvent={openOccurrence}
              onOpenDay={(day) => {
                setDate(day);
                setView("day");
              }}
              onCreate={newEvent}
            />
          )}
        </main>
      </div>
      {editing ? (
        <EventDialog
          open
          isNew={editing.isNew}
          draft={editing.draft}
          onDraft={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
          calendars={calendars}
          zoneNote={
            editingCalendarZone && editingCalendarZone !== zone
              ? t("event.zoneNote", { zone: editingCalendarZone })
              : null
          }
          format={format}
          weekStart={weekStart}
          onSave={() => void commit()}
          onDelete={() => void destroy()}
          onClose={close}
        />
      ) : null}
      <ScopeDialog
        key={scopeFor ?? "closed"}
        open={scopeFor !== null}
        action={scopeFor ?? "save"}
        onChoose={(scope) => {
          const action = scopeFor;
          setScopeFor(null);
          void (action === "delete" ? destroy(scope) : commit(scope));
        }}
        onClose={() => setScopeFor(null)}
      />
      <Dialog
        open={calendarDialog !== null}
        title={calendarDialog === "new" ? t("calendars.add") : t("calendars.editTitle")}
        onClose={() => setCalendarDialog(null)}
        actions={
          <>
            <Button onClick={() => setCalendarDialog(null)}>{t("ui.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!calendarName.trim()}
              onClick={async () => {
                if (calendarDialog === "new") {
                  await data.store.addCalendar(calendarName, calendars).catch(fail);
                  await data.refresh();
                } else if (calendarDialog)
                  await saveCalendars(
                    calendars.map((entry) =>
                      entry.id === calendarDialog.id
                        ? { ...calendarDialog, name: calendarName.trim().slice(0, 80) }
                        : entry,
                    ),
                  );
                setCalendarDialog(null);
              }}
            >
              {t("ui.save")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("calendars.name")}
          value={calendarName}
          maxLength={80}
          autoFocus
          onChange={(event) => setCalendarName(event.target.value)}
        />
        {calendarDialog && calendarDialog !== "new" ? (
          <div className="cal-colors" role="radiogroup" aria-label={t("calendars.color")}>
            {CALENDAR_COLORS.map((color, index) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={calendarDialog.color === color}
                aria-label={t("calendars.colorNumber", { number: index + 1 })}
                className="cal-color"
                style={{ background: color }}
                onClick={() => setCalendarDialog({ ...calendarDialog, color })}
              />
            ))}
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={importing !== null}
        title={t("ics.importTitle")}
        onClose={() => setImporting(null)}
        actions={
          <>
            <Button onClick={() => setImporting(null)}>{t("ui.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!importing?.imported.events.length}
              onClick={() => void finishImport()}
            >
              {t("ics.importAction", { count: importing?.imported.events.length ?? 0 })}
            </Button>
          </>
        }
      >
        {importing ? (
          <>
            <p>{t("ics.found", { count: importing.imported.events.length })}</p>
            {importing.imported.skipped ? (
              <p className="eui-hint">{t("ics.skipped", { count: importing.imported.skipped })}</p>
            ) : null}
            <Select
              label={t("ics.into")}
              value={importing.target}
              onChange={(target) => setImporting({ ...importing, target })}
              options={[
                {
                  value: "new",
                  label: t("ics.newCalendar", {
                    name: importing.imported.name ?? importing.fileName,
                  }),
                },
                ...calendars.map((calendar) => ({ value: calendar.id, label: calendar.name })),
              ]}
            />
          </>
        ) : null}
      </Dialog>
      <Dialog
        open={settingsOpen}
        title={t("settings.title")}
        onClose={() => setSettingsOpen(false)}
        actions={
          <Button onClick={() => setSettingsOpen(false)} icon={<X size={14} aria-hidden />}>
            {t("ui.close")}
          </Button>
        }
      >
        <Select<Settings["weekStart"]>
          label={t("settings.weekStart")}
          value={settings.weekStart}
          onChange={(weekStart) => setSettings({ ...settings, weekStart })}
          options={[
            {
              value: "auto",
              label: t("settings.weekStartAuto", {
                day: format.weekdayLong(addDays("2026-10-18", localeWeekStart(i18n.tag))),
              }),
            },
            { value: "1", label: format.weekdayLong("2026-10-19") },
            { value: "0", label: format.weekdayLong("2026-10-18") },
            { value: "6", label: format.weekdayLong("2026-10-24") },
          ]}
        />
        <p className="eui-hint">{t("settings.zone", { zone })}</p>
      </Dialog>
    </div>
  );
}
