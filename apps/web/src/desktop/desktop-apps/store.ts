import type { DesktopAppInstallationView } from "@everyos/shared";
import { desktopAppWidgetId, setDesktopAppWidgets, type WidgetManifest } from "@everyos/widget-sdk";
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
  /** Each active app's widget names (`<app id>#<widget id>`), likewise. */
  widgetNames: Readonly<Record<string, { name: string; description: string }>>;
  loaded: boolean;
}

export const useDesktopApps = create<DesktopAppsState>()(() => ({
  apps: [],
  names: {},
  widgetNames: {},
  loaded: false,
}));

interface Localized {
  name: string;
  widgets: Record<string, { name: string; description: string }>;
}

const cleanText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/**
 * The app's and its widgets' names in `locale`, from its package's `<locales.path>/<locale>.json`
 * (`app.name`, `widgets.<id>.name` and `.description`), else the manifest's English ones. The
 * texts are the publisher's: shown as text only.
 */
async function localized(app: DesktopAppInstallationView, locale: string): Promise<Localized> {
  const fallback: Localized = {
    name: app.name,
    widgets: Object.fromEntries(
      app.widgets.map((widget) => [
        widget.id,
        { name: widget.name, description: widget.description },
      ]),
    ),
  };
  if (!app.locales) return fallback;
  const language = app.locales.supported.includes(locale) ? locale : app.locales.default;
  try {
    const response = await fetch(`${app.runtimeUrl}${app.locales.path}/${language}.json`);
    if (!response.ok) return fallback;
    const messages = (await response.json()) as {
      app?: { name?: unknown };
      widgets?: Record<string, { name?: unknown; description?: unknown } | undefined>;
    } | null;
    return {
      name: cleanText(messages?.app?.name, 64) ?? app.name,
      widgets: Object.fromEntries(
        app.widgets.map((widget) => {
          const texts = messages?.widgets?.[widget.id];
          return [
            widget.id,
            {
              name: cleanText(texts?.name, 64) ?? widget.name,
              description: cleanText(texts?.description, 200) ?? widget.description,
            },
          ];
        }),
      ),
    };
  } catch {
    return fallback;
  }
}

/** The widgets of active apps, as the desktop's widget system takes them. */
function widgetManifests(apps: readonly DesktopAppInstallationView[]): WidgetManifest[] {
  return apps
    .filter((app) => app.state === "active")
    .flatMap((app) =>
      app.widgets.map((widget): WidgetManifest => ({
        schemaVersion: 1,
        id: desktopAppWidgetId(app.appId, widget.id),
        version: 1,
        provider: "desktopApp",
        categories: ["apps"],
        supportedSizes: widget.sizes,
        defaultSize: widget.defaultSize,
        placements: widget.placements,
        permissions: ["apps:read"],
        dataSources: [],
        config: [],
      })),
    );
}

/** Names of the active apps and their widgets in `locale`. */
async function namesOf(apps: readonly DesktopAppInstallationView[], locale: string) {
  const entries = await Promise.all(
    apps
      .filter((app) => app.state === "active")
      .map(async (app) => [app, await localized(app, locale)] as const),
  );
  return {
    names: Object.fromEntries(entries.map(([app, texts]) => [app.appId, texts.name])),
    widgetNames: Object.fromEntries(
      entries.flatMap(([app, texts]) =>
        Object.entries(texts.widgets).map(([id, value]) => [
          desktopAppWidgetId(app.appId, id),
          value,
        ]),
      ),
    ),
  };
}

/** Loads the installed desktop apps (and their names) before windows are restored. */
export async function loadDesktopApps(locale: string, signal?: AbortSignal): Promise<void> {
  const { apps } = await api<{ apps: DesktopAppInstallationView[] }>(
    "/desktop-apps/installed",
    signal ? { signal } : {},
  );
  const texts = await namesOf(apps, locale);
  if (signal?.aborted) return;
  setDesktopAppWidgets(widgetManifests(apps));
  useDesktopApps.setState({ apps, ...texts, loaded: true });
}

export function clearDesktopApps(): void {
  setDesktopAppWidgets([]);
  useDesktopApps.setState({ apps: [], names: {}, widgetNames: {}, loaded: false });
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
  void namesOf(apps, locale).then((texts) => {
    if (useDesktopApps.getState().apps === apps) useDesktopApps.setState(texts);
  });
});

/** Reloads the installed apps after an install, update or removal (dock and launcher follow). */
export function refreshDesktopApps(): Promise<void> {
  return loadDesktopApps(i18next.language).catch(() => undefined);
}
