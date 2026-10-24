import type { EveryOSApp } from "@everyos/app-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeLogs, queryFor, type Draft, type LogView, type ReadMode } from "./logs.ts";

export function useLogData(
  app: EveryOSApp,
  allowed: boolean,
  applied: Draft | null,
  live: boolean,
) {
  const [view, setView] = useState<LogView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [visible, setVisible] = useState(true);
  const currentView = useRef<LogView | null>(null);
  const generation = useRef(0);
  const active = useRef<ReadMode | null>(null);
  const request = useCallback(
    async (mode: ReadMode) => {
      if (!allowed || !applied || active.current) return;
      const parsed = queryFor(applied, Date.now());
      if ("error" in parsed) {
        setError(new Error("invalid-filter"));
        return;
      }
      const previous = currentView.current;
      const query = { ...parsed.query };
      if (mode === "older") {
        const oldest = previous?.entries.at(-1);
        if (!oldest || !previous?.hasMore || previous.limited) return;
        query.before = oldest.cursor;
      }
      if (mode === "tail" && previous?.entries[0])
        query.since = Math.max(query.since ?? 0, Math.floor(previous.entries[0].ts));
      const token = ++generation.current;
      active.current = mode;
      setBusy(true);
      setError(null);
      try {
        const page = await app.host.call("logs.query", query);
        if (token !== generation.current) return;
        const next = mergeLogs(previous, page, mode, parsed.query, Date.now());
        currentView.current = next;
        setView(next);
      } catch (cause) {
        if (token === generation.current) setError(cause);
      } finally {
        if (token === generation.current) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [app, allowed, applied],
  );

  useEffect(() => {
    generation.current++;
    active.current = null;
    currentView.current = null;
    setView(null);
    setBusy(false);
    setError(null);
    if (allowed && applied) void request("replace");
    return () => {
      generation.current++;
      active.current = null;
    };
  }, [allowed, applied, request]);
  useEffect(() => {
    const suspend = app.lifecycle.onSuspend(() => setVisible(false));
    const resume = app.lifecycle.onResume(() => {
      setVisible(true);
      if (live) void request("tail");
    });
    return () => {
      suspend();
      resume();
    };
  }, [app, live, request]);
  useEffect(() => {
    if (!allowed || !live || !visible || busy || !applied) return;
    const timer = setInterval(() => void request("tail"), 3000);
    return () => clearInterval(timer);
  }, [allowed, live, visible, busy, applied, request]);

  const pause = () => {
    // Pausing freezes the view even if an outstanding poll finishes a moment later.
    if (active.current !== "tail") return;
    generation.current++;
    active.current = null;
    setBusy(false);
  };
  return { view: allowed ? view : null, busy, error, visible, request, pause };
}
