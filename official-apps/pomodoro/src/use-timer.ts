import { useApp, usePersistentState, useT } from "@everyos/app-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeSessions } from "./stats.ts";
import {
  advance,
  applySettings,
  DEFAULT_SETTINGS,
  durationMs,
  initialState,
  pause,
  reset,
  skip,
  start,
  type Completion,
  type Phase,
  type Session,
  type TimerSettings,
  type TimerState,
} from "./timer.ts";

/*
 * The timer shared by the window and the widget through the app's storage: whoever changes it
 * writes the state with a higher revision, the others adopt it on their next look (every 2 s while
 * visible, and when they come back). The countdown itself is computed locally from `endsAt`.
 */

const POLL_MS = 2000;
const TICK_MS = 250;
/** The window says it is open this often; the widget notifies only when it has not for a while. */
const HEARTBEAT_MS = 5000;
const HEARTBEAT_STALE_MS = 12_000;

export function useTimer(role: "window" | "widget") {
  const app = useApp();
  const t = useT();
  const [settings, setSettings, settingsStatus] = usePersistentState<TimerSettings>(
    "settings",
    DEFAULT_SETTINGS,
    { delayMs: 200 },
  );
  const [state, setStateValue] = useState<TimerState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const current = useRef<TimerState | null>(null);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });

  const adopt = useCallback((next: TimerState) => {
    current.current = next;
    setStateValue(next);
  }, []);

  const read = useCallback(async () => {
    const stored = await app.storage.get<TimerState>("state");
    return stored && typeof stored.rev === "number" ? stored : null;
  }, [app]);

  /** Takes a newer state another instance wrote. */
  const refresh = useCallback(async () => {
    try {
      const stored = await read();
      if (stored && (!current.current || stored.rev > current.current.rev)) adopt(stored);
      else if (!stored && !current.current) adopt(initialState(settingsRef.current));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [adopt, read]);

  const write = useCallback(
    async (next: TimerState) => {
      adopt(next);
      try {
        await app.storage.set("state", next);
        setError(null);
      } catch (caught) {
        setError(caught);
      }
    },
    [adopt, app],
  );

  const record = useCallback(
    async (sessions: Session[]) => {
      if (!sessions.length) return;
      const history = (await app.storage.get<Session[]>("history")) ?? [];
      await app.storage.set("history", mergeSessions(history, sessions));
    },
    [app],
  );

  const notify = useCallback(
    async (completion: Completion) => {
      if (!settingsRef.current.notify || !app.permissions.has("notifications:send")) return;
      if (role === "widget") {
        const beat = await app.storage.get<{ at: number }>("window");
        if (beat && Date.now() - beat.at < HEARTBEAT_STALE_MS) return;
      }
      // Claim this phase end, so the window and the widget do not both announce it.
      const key = `${completion.phase}:${completion.endedAt}`;
      if ((await app.storage.get<string>("notified")) === key) return;
      await app.storage.set("notified", key);
      const minutes = durationMs(completion.next, settingsRef.current) / 60_000;
      await app.notifications.send({
        title: t(completion.phase === "focus" ? "notify.focusDone" : "notify.breakDone"),
        body: t(`notify.next.${completion.next}`, { minutes }),
        tag: "phase",
      });
    },
    [app, role, t],
  );

  /** Completes phases that ended (re-reading first, so only one instance records them). */
  const settle = useCallback(async () => {
    const mine = current.current;
    if (!mine || mine.status !== "running" || mine.endsAt === null || Date.now() < mine.endsAt)
      return;
    try {
      const stored = await read();
      const base = stored && stored.rev > mine.rev ? stored : mine;
      const { state: next, completed } = advance(base, settingsRef.current, Date.now());
      if (!completed.length) {
        if (base !== mine) adopt(base);
        return;
      }
      await write(next);
      await record(
        completed.flatMap((completion) => (completion.session ? [completion.session] : [])),
      );
      await notify(completed.at(-1)!);
    } catch (caught) {
      setError(caught);
    }
  }, [adopt, notify, read, record, write]);

  useEffect(() => {
    void refresh();
    const tick = setInterval(() => {
      setNow(Date.now());
      void settle();
    }, TICK_MS);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const stopResume = app.lifecycle.onResume(() => void refresh());
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      stopResume();
    };
  }, [app, refresh, settle]);

  useEffect(() => {
    if (role !== "window") return;
    const beat = () => void app.storage.set("window", { at: Date.now() }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [app, role]);

  // New durations reach an idle timer at once.
  useEffect(() => {
    const mine = current.current;
    if (!mine || !settingsStatus.loaded) return;
    const next = applySettings(mine, settings);
    if (next !== mine) void write(next);
  }, [settings, settingsStatus.loaded, write]);

  const act = useCallback(
    async (
      change: (state: TimerState, at: number) => { state: TimerState; session?: Session | null },
    ) => {
      const mine = current.current;
      if (!mine) return;
      const result = change(mine, Date.now());
      if (result.state === mine) return;
      await write(result.state);
      if (result.session) await record([result.session]).catch(setError);
    },
    [record, write],
  );

  return {
    state,
    now,
    error,
    settings,
    setSettings,
    start: () => act((s, at) => ({ state: start(s, at) })),
    pause: () => act((s, at) => ({ state: pause(s, at) })),
    toggle: () => act((s, at) => ({ state: s.status === "running" ? pause(s, at) : start(s, at) })),
    skip: () => act((s, at) => skip(s, settingsRef.current, at)),
    reset: () => act((s, at) => reset(s, settingsRef.current, at)),
    /** Switches to another phase (stops the current one). */
    choose: (phase: Phase) =>
      act((s, at) => {
        if (s.phase === phase) return { state: s };
        const stopped = reset(s, settingsRef.current, at);
        const duration = durationMs(phase, settingsRef.current);
        return {
          state: { ...stopped.state, phase, remainingMs: duration, phaseMs: duration },
          session: stopped.session,
        };
      }),
    setLabel: (label: string) =>
      act((s) => ({ state: { ...s, label: label.slice(0, 120), rev: s.rev + 1 } })),
  };
}

export type Timer = ReturnType<typeof useTimer>;
