import { errorMessage, useApp, useT, useToast } from "@everyos/app-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { systemTimeZone } from "./dates.ts";
import type { Calendar, CalendarEvent } from "./model.ts";
import { dueReminders } from "./reminders.ts";
import { CalendarStore } from "./store.ts";

/** How often the window checks reminders and says it is open (for the widget). */
export const REMINDER_CHECK_MS = 30_000;
/** A window heartbeat older than this means no window is open. */
const HEARTBEAT_STALE_MS = 75_000;

/** The person's calendars and events, kept current with what other instances write. */
export function useCalendar() {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const store = useMemo(() => new CalendarStore(app), [app]);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const zone = useMemo(() => systemTimeZone(), []);

  const fail = useCallback(
    (caught: unknown) => {
      const message = errorMessage(t, caught);
      if (message) toast(message, "danger");
    },
    [t, toast],
  );

  const refresh = useCallback(async () => {
    try {
      const [loadedCalendars, loadedEvents] = await Promise.all([
        store.calendars(t("calendars.personal")),
        store.events(),
      ]);
      setCalendars(loadedCalendars);
      setEvents(loadedEvents);
    } catch (caught) {
      fail(caught);
      setCalendars((current) => current ?? []);
      setEvents((current) => current ?? []);
    }
  }, [fail, store, t]);

  useEffect(() => {
    void refresh();
    // Another window or the widget changed something: read again when this one is looked at.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const stop = app.lifecycle.onResume(onFocus);
    const timer = setInterval(onFocus, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      stop();
      clearInterval(timer);
    };
  }, [app, refresh]);

  const save = useCallback(
    async (...changed: CalendarEvent[]) => {
      try {
        const saved = await store.put(...changed);
        setEvents((current) => {
          const list = [...(current ?? [])];
          for (const event of saved) {
            const index = list.findIndex((entry) => entry.id === event.id);
            if (index === -1) list.push(event);
            else list[index] = event;
          }
          return list;
        });
        return true;
      } catch (caught) {
        fail(caught);
        return false;
      }
    },
    [fail, store],
  );

  const remove = useCallback(
    async (...ids: string[]) => {
      try {
        await store.remove(...ids);
        setEvents((current) => (current ?? []).filter((event) => !ids.includes(event.id)));
        return true;
      } catch (caught) {
        fail(caught);
        return false;
      }
    },
    [fail, store],
  );

  const saveCalendars = useCallback(
    async (next: Calendar[]) => {
      setCalendars(next);
      try {
        await store.saveCalendars(next);
      } catch (caught) {
        fail(caught);
      }
    },
    [fail, store],
  );

  return { store, events, calendars, zone, refresh, save, remove, saveCalendars, fail };
}

/**
 * Sends reminders that came due, once each (claimed in storage). The widget leaves them to an open
 * window, which says it is there with a heartbeat.
 */
export function useReminders(
  events: CalendarEvent[] | null,
  calendars: Calendar[] | null,
  zone: string,
  role: "window" | "widget",
  describe: (event: CalendarEvent, start: number) => string,
) {
  const app = useApp();
  const latest = useRef(describe);
  useEffect(() => {
    latest.current = describe;
  });

  useEffect(() => {
    if (role !== "window") return;
    const beat = () => void app.storage.set("window", { at: Date.now() }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, REMINDER_CHECK_MS);
    return () => clearInterval(timer);
  }, [app, role]);

  useEffect(() => {
    if (!events || !calendars || !app.permissions.has("notifications:send")) return;
    // Hidden calendars still remind: hiding is about the view, not about forgetting.
    const check = async () => {
      if (role === "widget") {
        const beat = await app.storage.get<{ at: number }>("window");
        if (beat && Date.now() - beat.at < HEARTBEAT_STALE_MS) return;
      }
      const stored = await app.storage.get<string[]>("reminded");
      const sent = new Set(Array.isArray(stored) ? stored : []);
      const due = dueReminders(events, sent, Date.now(), zone);
      if (!due.length) return;
      for (const reminder of due) sent.add(reminder.key);
      await app.storage.set("reminded", [...sent].slice(-500));
      for (const reminder of due)
        await app.notifications.send({
          title: reminder.occurrence.event.title || "—",
          body: latest.current(reminder.occurrence.event, reminder.occurrence.start),
          tag: `event:${reminder.key}`,
        });
    };
    void check().catch(() => undefined);
    const timer = setInterval(() => void check().catch(() => undefined), REMINDER_CHECK_MS);
    return () => clearInterval(timer);
  }, [app, calendars, events, role, zone]);
}
