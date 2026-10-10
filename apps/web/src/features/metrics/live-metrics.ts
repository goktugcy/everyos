import type { MetricsHistory, MetricsPoint, MetricsSnapshot } from "@otuken/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../lib/api.ts";
import { useSessionStore } from "../../stores/session-store.ts";

/** Points older than this are dropped from the live buffer. */
const LIVE_WINDOW_MS = 15 * 60_000;
const MAX_RETRY_MS = 30_000;

export type LiveStatus = "idle" | "connecting" | "live" | "retrying";

interface LiveMetricsState {
  status: LiveStatus;
  snapshot: MetricsSnapshot | null;
  /** Last 15 minutes of points, oldest first. */
  points: MetricsPoint[];
}

/**
 * Live host metrics shared by every component in the tab (menu bar module,
 * System Monitor, widgets). A single EventSource is open only while at least
 * one component subscribes and the tab is visible, so the server samples
 * quickly only when someone is actually looking.
 */
export const useLiveMetrics = create<LiveMetricsState>()(() => ({
  status: "idle",
  snapshot: null,
  points: [],
}));

let subscribers = 0;
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1_000;

export function mergePoints(
  current: readonly MetricsPoint[],
  incoming: readonly MetricsPoint[],
  now: number,
): MetricsPoint[] {
  const byTime = new Map<number, MetricsPoint>();
  for (const point of current) byTime.set(point.at, point);
  for (const point of incoming) byTime.set(point.at, point);
  const cutoff = now - LIVE_WINDOW_MS;
  return [...byTime.values()].filter((point) => point.at >= cutoff).sort((a, b) => a.at - b.at);
}

async function seedHistory(): Promise<void> {
  try {
    const history = await api<MetricsHistory>("/system/metrics/history?range=15m");
    useLiveMetrics.setState((state) => ({
      points: mergePoints(state.points, history.points, history.points.at(-1)?.at ?? Date.now()),
    }));
  } catch {
    // Live points still arrive; the chart simply starts shorter.
  }
}

function close(): void {
  source?.close();
  source = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function canConnect(): boolean {
  const session = useSessionStore.getState();
  return (
    subscribers > 0 &&
    document.visibilityState === "visible" &&
    session.phase === "authenticated" &&
    !session.locked
  );
}

function connect(): void {
  if (source || !canConnect()) return;
  useLiveMetrics.setState({
    status: useLiveMetrics.getState().snapshot ? "retrying" : "connecting",
  });
  const events = new EventSource("/api/events?topics=metrics");
  source = events;
  events.addEventListener("ready", () => {
    retryDelay = 1_000;
    useLiveMetrics.setState({ status: "live" });
    void seedHistory();
  });
  events.addEventListener("metrics", (event) => {
    const snapshot = JSON.parse((event as MessageEvent<string>).data) as MetricsSnapshot;
    useLiveMetrics.setState((state) => ({
      snapshot,
      points: mergePoints(state.points, [snapshot.point], snapshot.point.at),
    }));
  });
  events.onerror = () => {
    // CONNECTING means the browser is already retrying a dropped connection.
    if (events.readyState !== EventSource.CLOSED) {
      useLiveMetrics.setState({ status: "retrying" });
      return;
    }
    // The server refused the stream (signed out, locked, no permission).
    // A normal request lets the global session handlers react to that.
    close();
    useLiveMetrics.setState({ status: "retrying" });
    void api("/system/metrics").catch(() => undefined);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  };
}

function reconcile(): void {
  if (canConnect()) connect();
  else {
    close();
    if (subscribers === 0) useLiveMetrics.setState({ status: "idle" });
  }
}

let listening = false;
function listenOnce(): void {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", reconcile);
  useSessionStore.subscribe((state, previous) => {
    if (state.locked !== previous.locked || state.phase !== previous.phase) {
      if (state.phase !== "authenticated") useLiveMetrics.setState({ snapshot: null, points: [] });
      reconcile();
    }
  });
}

/** Keeps the shared live metrics stream open while the calling component is mounted. */
export function useLiveMetricsSubscription(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    listenOnce();
    subscribers++;
    reconcile();
    return () => {
      subscribers--;
      reconcile();
    };
  }, [enabled]);
}
