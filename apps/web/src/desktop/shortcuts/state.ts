import { MAX_CUSTOM_SHORTCUTS, type CustomShortcut } from "@everyos/shared";
import { addShortcut } from "../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import type { GridMetrics } from "../surface/icon-grid.ts";

export function saveCustomShortcut(
  entry: CustomShortcut,
  placement: {
    desktop: boolean;
    dock: boolean;
    desktopId: string;
    metrics: GridMetrics;
    editing: boolean;
  },
): boolean {
  const state = usePreferences.getState();
  const duplicate =
    !placement.editing &&
    state.shortcuts.entries.find(
      (existing) =>
        existing.name === entry.name &&
        existing.icon === entry.icon &&
        existing.source === entry.source &&
        existing.permission === entry.permission &&
        JSON.stringify(existing.target) === JSON.stringify(entry.target),
    );
  const value = duplicate || entry;
  const exists = state.shortcuts.entries.some((item) => item.id === value.id);
  if (
    (!exists && state.shortcuts.entries.length >= MAX_CUSTOM_SHORTCUTS) ||
    (!placement.editing &&
      placement.dock &&
      !state.dock.pinned.includes(value.id) &&
      state.dock.pinned.length >= 32) ||
    (!placement.editing &&
      placement.desktop &&
      !state.desktop.items.some(
        (item) =>
          item.kind === "app" && item.appId === value.id && item.desktopId === placement.desktopId,
      ) &&
      state.desktop.items.length >= 300)
  )
    return false;
  updatePreference("shortcuts", (doc) => ({
    ...doc,
    entries: exists
      ? doc.entries.map((item) => (item.id === value.id ? value : item))
      : [...doc.entries, value],
  }));
  if (!placement.editing && placement.desktop)
    updatePreference("desktop", (doc) =>
      addShortcut(doc, value.id, placement.desktopId, placement.metrics),
    );
  if (!placement.editing && placement.dock)
    updatePreference("dock", (doc) => ({
      ...doc,
      pinned: doc.pinned.includes(value.id) ? doc.pinned : [...doc.pinned, value.id],
    }));
  return true;
}
