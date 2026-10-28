import { EVERYOS_VERSION, type SelfUpdateStatus } from "@everyos/shared";
import { useEffect, useRef } from "react";
import { flushPending } from "../../desktop/state/preferences-store.ts";
import { api } from "../../lib/api.ts";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { createUpdateReload } from "./update-reload.ts";

/** Stays mounted even when Updates is closed; polling covers a restart's missed SSE event. */
export function useUpdateReload(enabled: boolean): void {
  const observe = useRef<ReturnType<typeof createUpdateReload> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    observe.current ??= createUpdateReload({
      currentVersion: EVERYOS_VERSION,
      storage: {
        getItem: (key) => sessionStorage.getItem(key),
        setItem: (key, value) => sessionStorage.setItem(key, value),
      },
      beforeReload: flushPending,
      reload: () => window.location.reload(),
    });
    let disposed = false;
    let revision = 0;
    let controller: AbortController | null = null;
    const accept = (value: SelfUpdateStatus) => {
      revision++;
      controller?.abort();
      void observe.current?.(value);
    };
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const requestRevision = ++revision;
      try {
        const value = await api<SelfUpdateStatus>("/self-update", { signal, quiet401: true });
        if (!disposed && !signal.aborted && revision === requestRevision) accept(value);
      } catch {
        /* Expected while the API restarts; a later read must prove completion. */
      }
    };
    const unsubscribe = subscribeTopic("release", {
      ready: () => void refresh(),
      events: { "release.status": (value) => accept(value as SelfUpdateStatus) },
    });
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    const visible = () => void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled]);
}
