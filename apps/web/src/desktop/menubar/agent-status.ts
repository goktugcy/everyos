import type { HealthResponse } from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../lib/api.ts";

const POLL_MS = 30_000;

/** Agent connectivity from the public health endpoint, shared by all subscribers. */
export const useAgentStatus = create<{ agent: HealthResponse["checks"]["agent"] | null }>()(() => ({
  agent: null,
}));

let subscribers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function poll(): Promise<void> {
  if (document.visibilityState === "visible") {
    try {
      const health = await api<HealthResponse>("/health");
      useAgentStatus.setState({ agent: health.checks.agent });
    } catch {
      useAgentStatus.setState({ agent: "unavailable" });
    }
  }
  if (subscribers > 0) timer = setTimeout(() => void poll(), POLL_MS);
}

/** Keeps polling while at least one component uses the status. */
export function useAgentStatusPolling(): void {
  useEffect(() => {
    subscribers++;
    if (subscribers === 1) void poll();
    return () => {
      subscribers--;
      if (subscribers === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);
}
