import { api } from "../../lib/api.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { wm } from "../state/window-store.ts";
import { desktopAppWindowId } from "./store.ts";

/** Called only after confirmation; update this person's shortcuts after the API accepts removal. */
export async function uninstallDesktopApp(appId: string): Promise<void> {
  await api(`/desktop-apps/installed/${appId}`, { method: "DELETE", body: { confirm: true } });
  const id = desktopAppWindowId(appId);
  const preferences = usePreferences.getState();
  const ids = new Set([
    id,
    ...preferences.shortcuts.entries
      .filter((entry) => entry.target.kind === "app" && entry.target.appId === id)
      .map((entry) => entry.id),
  ]);
  if (preferences.desktop.items.some((item) => item.kind === "app" && ids.has(item.appId)))
    updatePreference("desktop", (doc) => ({
      ...doc,
      items: doc.items.filter((item) => item.kind !== "app" || !ids.has(item.appId)),
    }));
  if (preferences.dock.pinned.some((entry) => ids.has(entry)))
    updatePreference("dock", (doc) => ({
      ...doc,
      pinned: doc.pinned.filter((entry) => !ids.has(entry)),
    }));
  for (const window of Object.values(wm().windows)) if (window.appId === id) wm().close(window.id);
}
