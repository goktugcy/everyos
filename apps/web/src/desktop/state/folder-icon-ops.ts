import type { AppearancePreferences } from "@everyos/shared";
import { useSessionStore } from "../../stores/session-store.ts";
import { updatePreference, usePreferences } from "./preferences-store.ts";

interface Location {
  root: string;
  path: string;
}

/** Follow the folder and its descendants after a successful file operation. */
export function relocateFolderIcons(
  current: AppearancePreferences,
  from: Location,
  to: Location,
  copy: boolean,
): AppearancePreferences {
  const icons = current.folderIcons ?? [];
  const matches = (item: Location) =>
    item.root === from.root && (item.path === from.path || item.path.startsWith(`${from.path}/`));
  const moved = icons
    .filter(matches)
    .map((item) => ({ ...item, root: to.root, path: to.path + item.path.slice(from.path.length) }));
  if (moved.length === 0) return current;
  const targets = new Set(moved.map((item) => `${item.root}/${item.path}`));
  const remaining = icons.filter(
    (item) => (copy || !matches(item)) && !targets.has(`${item.root}/${item.path}`),
  );
  return { ...current, folderIcons: [...remaining, ...moved].slice(0, 500) };
}

export function followFolderIcons(from: Location, to: Location, copy = false): void {
  if (
    !usePreferences.getState().ready ||
    !useSessionStore.getState().session?.permissions.includes("preferences:manage")
  )
    return;
  const current = usePreferences.getState().appearance;
  const next = relocateFolderIcons(current, from, to, copy);
  if (next !== current) updatePreference("appearance", () => next);
}
