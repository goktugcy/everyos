import type { AiAgentView } from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../../lib/api.ts";
import { useSessionStore } from "../../../stores/session-store.ts";

interface State {
  agents: AiAgentView[];
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
}
let controller: AbortController | null = null;
let revision = 0;
export const useAiAgents = create<State>((set) => ({
  agents: [],
  error: null,
  loading: false,
  refresh: async () => {
    const session = useSessionStore.getState();
    const sessionId = session.session?.session.id;
    if (
      session.phase !== "authenticated" ||
      session.locked ||
      !sessionId ||
      !session.session?.permissions.includes("terminal:access") ||
      !session.session.permissions.includes("apps:manage") ||
      document.visibilityState !== "visible"
    )
      return;
    controller?.abort();
    controller = new AbortController();
    const current = ++revision;
    set({ loading: true });
    try {
      const result = await api<{ agents: AiAgentView[] }>("/ai-agents", {
        signal: controller.signal,
      });
      const live = useSessionStore.getState();
      if (current === revision && !live.locked && live.session?.session.id === sessionId)
        set({ agents: result.agents, error: null });
    } catch (error) {
      if (current === revision && !(error instanceof DOMException && error.name === "AbortError"))
        set({ error, agents: [] });
    } finally {
      if (current === revision) set({ loading: false });
    }
  },
}));

/** One shell-owned poller; no secrets, history or stale previous-session status in the menu bar. */
export function useAiAgentPolling() {
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const locked = useSessionStore((state) => state.locked);
  const allowed = useSessionStore(
    (state) =>
      state.session?.permissions.includes("terminal:access") &&
      state.session.permissions.includes("apps:manage"),
  );
  useEffect(() => {
    const reset = () => {
      revision++;
      controller?.abort();
      useAiAgents.setState({ agents: [], error: null, loading: false });
    };
    reset();
    if (!sessionId || locked || !allowed) return;
    const refresh = () => void useAiAgents.getState().refresh();
    refresh();
    const timer = setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      reset();
    };
  }, [sessionId, locked, allowed]);
}
