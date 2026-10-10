import type {
  AppearancePreferences,
  DesktopPreferences,
  DockPreferences,
  MenubarPreferences,
  Permission,
  PreferenceDocuments,
  PreferenceKey,
  SecurityPreferences,
  WidgetPreferences,
  WindowSession,
} from "@otuken/shared";
import { defaultWidgetPreferences, migrateWidgets } from "@otuken/widget-sdk";
import { DEFAULT_APPEARANCE } from "@otuken/theme";
import type { TFunction } from "i18next";
import { create } from "zustand";
import { api, ApiRequestError } from "../../lib/api.ts";
import { applyAppearance } from "../theme/theme-store.ts";
import { DEFAULT_MENUBAR, DEFAULT_SECURITY, defaultDesktop, defaultDock } from "./defaults.ts";

type EditableKey = Exclude<PreferenceKey, "windows">;

export interface PreferencesState {
  ready: boolean;
  appearance: AppearancePreferences;
  desktop: DesktopPreferences;
  dock: DockPreferences;
  menubar: MenubarPreferences;
  security: SecurityPreferences;
  widgets: WidgetPreferences;
  /** Window session loaded at sign-in; consumed once by the shell. */
  initialWindows: WindowSession | null;
  saveError: boolean;
}

export const usePreferences = create<PreferencesState>()(() => ({
  ready: false,
  appearance: DEFAULT_APPEARANCE,
  desktop: { version: 1, desktops: [{ id: "d1", name: "", wallpaper: null }], items: [] },
  dock: defaultDock([]),
  menubar: DEFAULT_MENUBAR,
  security: DEFAULT_SECURITY,
  widgets: { version: 1, instances: [], sidebar: { open: false } },
  initialWindows: null,
  saveError: false,
}));

/* ----------------------------- saving ----------------------------- */

const SAVE_DELAY_MS = 800;
const RETRY_DELAY_MS = 10_000;
const pending = new Map<PreferenceKey, () => unknown>();
const timers = new Map<PreferenceKey, ReturnType<typeof setTimeout>>();
const inFlight = new Map<PreferenceKey, Promise<void>>();
let generation = 0;

async function flushKey(key: PreferenceKey, keepalive = false): Promise<void> {
  const previous = inFlight.get(key);
  if (previous) {
    const currentGeneration = generation;
    await previous;
    if (currentGeneration === generation) await flushKey(key, keepalive);
    return;
  }
  const read = pending.get(key);
  if (!read) return;
  pending.delete(key);
  clearTimeout(timers.get(key));
  const currentGeneration = generation;
  const saving = (async () => {
    try {
      await api(`/preferences/${key}`, { method: "PUT", body: read(), keepalive });
      if (currentGeneration === generation && pending.size === 0)
        usePreferences.setState({ saveError: false });
    } catch (error) {
      // A completed request must never enqueue another user's preferences.
      if (currentGeneration !== generation) return;
      if (error instanceof ApiRequestError && error.status === 401) return;
      if (!pending.has(key)) pending.set(key, read);
      const locked = error instanceof ApiRequestError && error.code === "SESSION_LOCKED";
      if (!locked) usePreferences.setState({ saveError: true });
      timers.set(
        key,
        setTimeout(() => void flushKey(key), RETRY_DELAY_MS),
      );
    }
  })();
  inFlight.set(key, saving);
  await saving;
  if (inFlight.get(key) === saving) inFlight.delete(key);
}

/** Debounced save of a preference document; `read` is evaluated at send time. */
export function scheduleSave(key: PreferenceKey, read: () => unknown, delay = SAVE_DELAY_MS): void {
  pending.set(key, read);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => void flushKey(key), delay),
  );
}

/** Sends everything still queued, surviving page unload. */
export function flushPreferences(): void {
  for (const key of [...pending.keys()]) void flushKey(key, true);
}

/** Sends everything still queued and waits for the requests (used before signing out). */
export async function flushPending(): Promise<void> {
  await Promise.all(
    [...new Set([...pending.keys(), ...inFlight.keys()])].map((key) => flushKey(key)),
  );
}

/** Drops queued saves and timers (the user signed out). */
export function discardPending(): void {
  generation++;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  inFlight.clear();
}

/** Retries queued saves now (e.g. right after unlocking). */
export function retryPendingSaves(): void {
  for (const key of [...pending.keys()]) void flushKey(key);
}

/* ----------------------------- updates ----------------------------- */

export function updatePreference<K extends EditableKey>(
  key: K,
  updater: (current: PreferencesState[K]) => PreferencesState[K],
): void {
  const next = updater(usePreferences.getState()[key]);
  usePreferences.setState({ [key]: next } as Pick<PreferencesState, K>);
  if (key === "appearance") applyAppearance(next as AppearancePreferences);
  scheduleSave(key, () => usePreferences.getState()[key]);
}

/* ----------------------------- loading ----------------------------- */

export interface LoadContext {
  t: TFunction;
  permissions: readonly Permission[];
}

export async function loadPreferences(context: LoadContext, signal?: AbortSignal): Promise<void> {
  const currentGeneration = generation;
  const stored = (
    await api<{ preferences: Partial<PreferenceDocuments> }>(
      "/preferences",
      signal ? { signal } : {},
    )
  ).preferences;
  if (signal?.aborted || currentGeneration !== generation) return;
  const appearance = stored.appearance ?? DEFAULT_APPEARANCE;
  applyAppearance(appearance);
  usePreferences.setState({
    ready: true,
    appearance,
    desktop: stored.desktop ?? defaultDesktop(context.t, context.permissions),
    dock: stored.dock ?? defaultDock(context.permissions),
    menubar: stored.menubar ?? DEFAULT_MENUBAR,
    security: stored.security ?? DEFAULT_SECURITY,
    widgets:
      (stored.widgets ? migrateWidgets(stored.widgets) : null) ??
      defaultWidgetPreferences(context.permissions, () => crypto.randomUUID()),
    initialWindows: usePreferences.getState().ready
      ? usePreferences.getState().initialWindows
      : (stored.windows ?? null),
    saveError: false,
  });
}

/** Saves defaults through the same ordered queue as edits, including offline retries. */
export function resetPreference(key: EditableKey, value: PreferencesState[EditableKey]): void {
  usePreferences.setState({ [key]: value } as Partial<PreferencesState>);
  if (key === "appearance") applyAppearance(value as AppearancePreferences);
  scheduleSave(key, () => usePreferences.getState()[key]);
}
