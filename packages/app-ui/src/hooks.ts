import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./app.tsx";

export interface Persisted {
  /** False until the stored value was read (render a loading state meanwhile). */
  loaded: boolean;
  saving: boolean;
  error: unknown;
}

/**
 * State kept in the app's per-person storage: read once, written after `delayMs` of quiet and
 * whenever the window goes to the background or closes, so nothing typed is lost.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  { delayMs = 400 }: { delayMs?: number } = {},
): [T, (next: T | ((current: T) => T)) => void, Persisted & { flush: () => Promise<void> }] {
  const app = useApp();
  const [value, setValue] = useState<T>(initial);
  const [status, setStatus] = useState<Persisted>({ loaded: false, saving: false, error: null });
  const pending = useRef<{ value: T } | null>(null);
  const writes = useRef(new Set<Promise<void>>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = pending.current;
    const prior = [...writes.current];
    if (!next) {
      await Promise.allSettled(prior);
      return;
    }
    pending.current = null;
    setStatus((current) => ({ ...current, saving: true }));
    const write = app.storage.set(key, next.value);
    writes.current.add(write);
    try {
      await write;
      setStatus((current) => ({ ...current, saving: false, error: null }));
    } catch (error) {
      setStatus((current) => ({ ...current, saving: false, error }));
    } finally {
      writes.current.delete(write);
    }
    await Promise.allSettled(prior);
  }, [app, key]);

  useEffect(() => {
    let stale = false;
    app.storage.get<T>(key).then(
      (stored) => {
        if (stale) return;
        if (stored !== undefined && stored !== null) setValue(stored);
        setStatus({ loaded: true, saving: false, error: null });
      },
      (error: unknown) => {
        if (!stale) setStatus({ loaded: true, saving: false, error });
      },
    );
    return () => {
      stale = true;
    };
  }, [app, key]);

  useEffect(() => {
    const stopSuspend = app.lifecycle.onSuspend(() => void flush());
    const unload = () => void flush();
    window.addEventListener("pagehide", unload);
    return () => {
      stopSuspend();
      window.removeEventListener("pagehide", unload);
      void flush();
    };
  }, [app, flush]);

  const update = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
        pending.current = { value: resolved };
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), delayMs);
        return resolved;
      });
    },
    [delayMs, flush],
  );
  const persisted = useMemo(() => ({ ...status, flush }), [status, flush]);
  return [value, update, persisted];
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** `mod+s`, `mod+shift+f`, `escape`, `alt+arrowup` … (`mod` is ⌘ on Apple devices, Ctrl elsewhere). */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop()!;
  const want = new Set(parts);
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (want.has("mod") !== mod) return false;
  if (want.has("shift") !== event.shiftKey) return false;
  if (want.has("alt") !== event.altKey) return false;
  if (!want.has("mod") && (event.ctrlKey || event.metaKey)) return false;
  return event.key.toLowerCase() === key || event.code.toLowerCase() === `key${key}`;
}

/** Keyboard shortcuts while the app has focus; handled ones do not reach the page. */
export function useShortcuts(bindings: Record<string, (event: KeyboardEvent) => void>): void {
  const current = useRef(bindings);
  useEffect(() => {
    current.current = bindings;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      for (const [shortcut, run] of Object.entries(current.current))
        if (matchesShortcut(event, shortcut)) {
          event.preventDefault();
          run(event);
          return;
        }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The shortcut as people read it on this device (`⌘S`, `Ctrl+S`). */
export function shortcutLabel(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "mod") return isMac ? "⌘" : "Ctrl";
      if (lower === "shift") return isMac ? "⇧" : "Shift";
      if (lower === "alt") return isMac ? "⌥" : "Alt";
      return part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1);
    })
    .join(isMac ? "" : "+");
}

export interface Async<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Loads data (again when `deps` change or on `reload`), ignoring answers that came too late. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let stale = false;
    setState((current) => ({ ...current, loading: true }));
    load().then(
      (data) => {
        if (!stale) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!stale) setState((current) => ({ ...current, error, loading: false }));
      },
    );
    return () => {
      stale = true;
    };
  }, [...deps, generation]);
  return { ...state, reload: () => setGeneration((value) => value + 1) };
}

/** Whether the window is narrow (phones, small windows): layouts collapse to one column. */
export function useNarrow(maxWidth = 640): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setNarrow(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

/** A value that settles `delayMs` after it last changed (search boxes). */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
