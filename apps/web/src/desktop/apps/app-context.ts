import { createContext, useContext } from "react";

/**
 * What an app sees of its host window. Desktop windows back it with the
 * window manager store; the mobile shell backs it with local state. Apps keep
 * navigation state (e.g. the open settings section) in `appState`, which is
 * persisted with the window layout.
 */
export interface AppHost {
  windowId: string;
  appState: unknown;
  setAppState(state: unknown): void;
  setTitle(title: string): void;
  close(): void;
}

export const AppHostContext = createContext<AppHost | null>(null);

export function useAppHost(): AppHost {
  const host = useContext(AppHostContext);
  if (!host) throw new Error("useAppHost must be used inside an app window");
  return host;
}

/** Typed view of a string-keyed field of the app state. */
export function useAppStateField<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const host = useAppHost();
  const state = (host.appState ?? {}) as Record<string, unknown>;
  const raw = state[key];
  const value =
    typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  return [value, (next) => host.setAppState({ ...state, [key]: next })];
}
