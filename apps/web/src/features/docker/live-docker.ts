import type { DockerChangeEvent, DockerStatsSnapshot } from "@otuken/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { subscribeTopic, type StreamStatus } from "../../lib/event-stream.ts";

interface LiveDockerState {
  status: "idle" | StreamStatus;
  stats: DockerStatsSnapshot | null;
  /** Increments (debounced) whenever Docker reports a change; views refetch on it. */
  revision: number;
  lastChange: DockerChangeEvent | null;
}

export const useLiveDocker = create<LiveDockerState>()(() => ({
  status: "idle",
  stats: null,
  revision: 0,
  lastChange: null,
}));

let subscribers = 0;
let unsubscribe: (() => void) | null = null;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

/** Bursts of events (e.g. `compose up` starting five containers) become one refetch. */
function bump(): void {
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    useLiveDocker.setState((state) => ({ revision: state.revision + 1 }));
  }, 400);
}

/** Live container stats and change notifications while the calling component is mounted. */
export function useLiveDockerSubscription(): void {
  useEffect(() => {
    subscribers++;
    if (subscribers === 1) {
      unsubscribe = subscribeTopic("docker", {
        // A reconnect may have missed changes.
        ready: bump,
        status: (status) => useLiveDocker.setState({ status }),
        events: {
          "docker.stats": (data) => useLiveDocker.setState({ stats: data as DockerStatsSnapshot }),
          "docker.change": (data) => {
            useLiveDocker.setState({ lastChange: data as DockerChangeEvent });
            bump();
          },
        },
      });
    }
    return () => {
      subscribers--;
      if (subscribers === 0) {
        unsubscribe?.();
        unsubscribe = null;
        useLiveDocker.setState({ status: "idle", stats: null });
      }
    };
  }, []);
}
