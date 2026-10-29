import { api } from "../../lib/api.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { wm } from "../state/window-store.ts";
import { desktopAppWindowId } from "./store.ts";

/** Called only after confirmation; update this person's shortcuts after the API accepts removal. */
export async function uninstallDesktopApp(appId: string): Promise<void> {
  await api(`/desktop-apps/installed/${appId}`, { method: "DELETE", body: { confirm: true } });
  const id = desktopAppWindowId(appId);
  const preferences = usePreferences.getState();
  if (preferences.desktop.items.some((item) => item.kind === "app" && item.appId === id))
    updatePreference("desktop", (doc) => ({
      ...doc,
      items: doc.items.filter((item) => item.kind !== "app" || item.appId !== id),
    }));
  if (preferences.dock.pinned.includes(id))
    updatePreference("dock", (doc) => ({
      ...doc,
      pinned: doc.pinned.filter((entry) => entry !== id),
    }));
  for (const window of Object.values(wm().windows)) if (window.appId === id) wm().close(window.id);
}
