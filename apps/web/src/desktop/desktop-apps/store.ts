import type { DesktopAppInstallationView } from "@everyos/shared";
import { create } from "zustand";
import { i18next } from "../../app/i18n.ts";
import { api } from "../../lib/api.ts";

/** Window and shortcut identity of an installed desktop app. */
export type DesktopAppWindowId = `everyos.desktop.${string}`;

const PREFIX = "everyos.desktop.";

export function desktopAppWindowId(appId: string): DesktopAppWindowId {
  return `everyos.desktop.${appId}`;
}

export function desktopAppIdOf(id: string): string | null {
  return id.startsWith(PREFIX) && id.length > PREFIX.length ? id.slice(PREFIX.length) : null;
}

interface DesktopAppsState {
  apps: readonly DesktopAppInstallationView[];
  /** Each active app's name in the interface language (from its own locale files). */
  names: Readonly<Record<string, string>>;
  loaded: boolean;
}

export const useDesktopApps = create<DesktopAppsState>()(() => ({
  apps: [],
  names: {},
  loaded: false,
}));

/**
 * The app's name in `locale`, from its package's `<locales.path>/<locale>.json` (`app.name`),
 * else the manifest's English name. The text is the publisher's: shown as text only.
 */
async function localizedName(app: DesktopAppInstallationView, locale: string): Promise<string> {
  if (!app.locales) return app.name;
  const language = app.locales.supported.includes(locale) ? locale : app.locales.default;
  try {
    const response = await fetch(`${app.runtimeUrl}${app.locales.path}/${language}.json`);
    if (!response.ok) return app.name;
    const messages = (await response.json()) as { app?: { name?: unknown } } | null;
    const name = messages?.app?.name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : app.name;
  } catch {
    return app.name;
  }
}

/** Loads the installed desktop apps (and their names) before windows are restored. */
export async function loadDesktopApps(locale: string, signal?: AbortSignal): Promise<void> {
  const { apps } = await api<{ apps: DesktopAppInstallationView[] }>(
    "/desktop-apps/installed",
    signal ? { signal } : {},
  );
  const names = Object.fromEntries(
    await Promise.all(
      apps
        .filter((app) => app.state === "active")
        .map(async (app) => [app.appId, await localizedName(app, locale)] as const),
    ),
  );
  if (signal?.aborted) return;
  useDesktopApps.setState({ apps, names, loaded: true });
}

export function clearDesktopApps(): void {
  useDesktopApps.setState({ apps: [], names: {}, loaded: false });
}

export function activeDesktopApp(appId: string): DesktopAppInstallationView | undefined {
  return useDesktopApps
    .getState()
    .apps.find((app) => app.appId === appId && app.state === "active");
}

// Names follow the interface language.
i18next.on("languageChanged", (locale: string) => {
  const { apps, loaded } = useDesktopApps.getState();
  if (!loaded) return;
  void Promise.all(
    apps
      .filter((app) => app.state === "active")
      .map(async (app) => [app.appId, await localizedName(app, locale)] as const),
  ).then((entries) => {
    if (useDesktopApps.getState().apps === apps)
      useDesktopApps.setState({ names: Object.fromEntries(entries) });
  });
});
