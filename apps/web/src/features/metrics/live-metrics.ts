import type { MetricsHistory, MetricsPoint, MetricsSnapshot } from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../lib/api.ts";
import { subscribeTopic, type StreamStatus } from "../../lib/event-stream.ts";
import { useSessionStore } from "../../stores/session-store.ts";

/** Points older than this are dropped from the live buffer. */
const LIVE_WINDOW_MS = 15 * 60_000;

export type LiveStatus = "idle" | StreamStatus;

interface LiveMetricsState {
  status: LiveStatus;
  snapshot: MetricsSnapshot | null;
  /** Last 15 minutes of points, oldest first. */
  points: MetricsPoint[];
}

/**
 * Live host metrics shared by every component in the tab (menu bar module,
 * System Monitor, widgets), carried by the shared event stream while at
 * least one component subscribes, so the server samples quickly only when
 * someone is actually looking.
 */
export const useLiveMetrics = create<LiveMetricsState>()(() => ({
  status: "idle",
  snapshot: null,
  points: [],
}));

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
      points: mergePoints(state.points, history.points, history.points.at(-1)?.at ?? 0),
    }));
  } catch {
    // Live points still arrive; the chart simply starts shorter.
  }
}

let subscribers = 0;
let unsubscribe: (() => void) | null = null;
let sessionWatch: (() => void) | null = null;

function start(): void {
  unsubscribe = subscribeTopic("metrics", {
    ready: () => void seedHistory(),
    status: (status) => useLiveMetrics.setState({ status }),
    events: {
      metrics: (data) => {
        const snapshot = data as MetricsSnapshot;
        useLiveMetrics.setState((state) => ({
          snapshot,
          points: mergePoints(state.points, [snapshot.point], snapshot.point.at),
        }));
      },
    },
  });
  // A different user (or a signed-out tab) must not see the previous data.
  sessionWatch = useSessionStore.subscribe((state, previous) => {
    if (state.phase !== previous.phase && state.phase !== "authenticated") {
      useLiveMetrics.setState({ snapshot: null, points: [] });
    }
  });
}

/** Keeps the shared live metrics stream open while the calling component is mounted. */
export function useLiveMetricsSubscription(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    subscribers++;
    if (subscribers === 1) start();
    return () => {
      subscribers--;
      if (subscribers === 0) {
        unsubscribe?.();
        sessionWatch?.();
        unsubscribe = null;
        sessionWatch = null;
        useLiveMetrics.setState({ status: "idle" });
      }
    };
  }, [enabled]);
}
