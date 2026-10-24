import { errorMessage, useApp, useT, useToast } from "@everyos/app-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { dueReminders, reminderKey, type Project, type Task } from "./model.ts";
import { TodoStore } from "./store.ts";

/*
 * The tasks of the person, kept in step with storage: read on start, again when the window comes
 * back and every few seconds (the widget may have changed them), written through the store.
 */

const REFRESH_MS = 5000;
const REMINDER_CHECK_MS = 30_000;
const HEARTBEAT_STALE_MS = 75_000;

export function useTodo() {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const store = useMemo(() => new TodoStore(app), [app]);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextProjects] = await Promise.all([store.tasks(), store.projects()]);
      setTasks(nextTasks);
      setProjects(nextProjects.sort((a, b) => a.order - b.order));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [store]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const stop = app.lifecycle.onResume(() => void refresh());
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [app, refresh]);

  const fail = useCallback(
    (caught: unknown) => toast(errorMessage(t, caught), "danger"),
    [t, toast],
  );

  /** Applies a change locally at once, then stores it. */
  const save = useCallback(
    async (task: Task) => {
      setTasks((list) => {
        if (!list) return list;
        const index = list.findIndex((entry) => entry.id === task.id);
        return index === -1
          ? [...list, task]
          : list.map((entry) => (entry.id === task.id ? task : entry));
      });
      try {
        await store.put(task);
      } catch (caught) {
        fail(caught);
        void refresh();
      }
    },
    [fail, refresh, store],
  );

  const change = useCallback(
    async (id: string, update: (task: Task) => Task) => {
      setTasks((list) => list?.map((entry) => (entry.id === id ? update(entry) : entry)) ?? list);
      try {
        const updated = await store.change(id, update);
        if (updated)
          setTasks((list) => list?.map((entry) => (entry.id === id ? updated : entry)) ?? list);
      } catch (caught) {
        fail(caught);
        void refresh();
      }
    },
    [fail, refresh, store],
  );

  const remove = useCallback(
    async (id: string) => {
      setTasks((list) => list?.filter((entry) => entry.id !== id) ?? list);
      try {
        await store.remove(id);
      } catch (caught) {
        fail(caught);
        void refresh();
      }
    },
    [fail, refresh, store],
  );

  return { store, tasks, projects, error, refresh, save, change, remove, fail };
}

/**
 * Sends reminders that came due, once each (claimed in storage). The widget leaves them to an
 * open window, which says it is there with a heartbeat.
 */
export function useReminders(tasks: Task[] | null, role: "window" | "widget") {
  const app = useApp();
  const t = useT();
  const i18n = useMemo(() => ({ t }), [t]);
  useEffect(() => {
    if (role !== "window") return;
    const beat = () => void app.storage.set("window", { at: Date.now() }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, REMINDER_CHECK_MS);
    return () => clearInterval(timer);
  }, [app, role]);

  useEffect(() => {
    if (!tasks || !app.permissions.has("notifications:send")) return;
    const check = async () => {
      if (role === "widget") {
        const beat = await app.storage.get<{ at: number }>("window");
        if (beat && Date.now() - beat.at < HEARTBEAT_STALE_MS) return;
      }
      const sent = new Set((await app.storage.get<string[]>("reminded")) ?? []);
      const due = dueReminders(tasks, sent, Date.now());
      if (!due.length) return;
      for (const task of due) sent.add(reminderKey(task));
      await app.storage.set("reminded", [...sent].slice(-500));
      for (const task of due)
        await app.notifications.send({
          title: task.title,
          body: task.dueTime
            ? i18n.t("reminder.at", { time: task.dueTime })
            : i18n.t("reminder.today"),
          tag: `task:${task.id}`,
        });
    };
    void check().catch(() => undefined);
    const timer = setInterval(() => void check().catch(() => undefined), REMINDER_CHECK_MS);
    return () => clearInterval(timer);
  }, [app, i18n, role, tasks]);
}
