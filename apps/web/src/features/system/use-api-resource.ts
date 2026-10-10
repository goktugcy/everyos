import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";

export interface ApiResource<T> {
  data: T | null;
  error: unknown;
  /** True until the first response (success or failure). */
  loading: boolean;
  /** True while a refresh is in flight after data exists (keep the frame, dim it). */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Fetches `path` and refreshes it every `refreshMs` while the tab is
 * visible. Changing `path` refetches immediately and keeps showing the
 * previous data until the new response arrives.
 */
export function useApiResource<T>(path: string | null, refreshMs: number | null): ApiResource<T> {
  const [state, setState] = useState<Omit<ApiResource<T>, "reload">>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (path === null) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const load = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      setState((previous) => ({ ...previous, refreshing: previous.data !== null }));
      try {
        const data = await api<T>(path, { signal: controller.signal });
        if (!disposed) setState({ data, error: null, loading: false, refreshing: false });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!disposed)
          setState((previous) => ({ ...previous, error, loading: false, refreshing: false }));
      }
    };
    const schedule = () => {
      if (refreshMs === null || disposed) return;
      timer = setTimeout(() => void load().finally(schedule), refreshMs);
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
  }, [path, refreshMs, generation]);

  return { ...state, reload };
}
