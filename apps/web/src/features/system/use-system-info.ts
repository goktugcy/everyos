import type { SystemInfo } from "@everyos/shared";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";

const REFRESH_MS = 30_000;

export interface SystemInfoState {
  info: SystemInfo | null;
  error: unknown;
  loading: boolean;
}

/**
 * Polls host information while the page is visible. Requests are aborted on
 * unmount and paused while the tab is hidden to avoid needless load on the
 * server. (Phase 3 replaces polling with a shared SSE metrics stream.)
 */
export function useSystemInfo(): SystemInfoState {
  const [state, setState] = useState<SystemInfoState>({ info: null, error: null, loading: true });

  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const load = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const info = await api<SystemInfo>("/system/info", { signal: controller.signal });
        if (!disposed) setState({ info, error: null, loading: false });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!disposed) setState((previous) => ({ info: previous.info, error, loading: false }));
      }
    };
    const schedule = () => {
      timer = setTimeout(() => {
        void load().finally(schedule);
      }, REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };

    void load().finally(schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return state;
}
