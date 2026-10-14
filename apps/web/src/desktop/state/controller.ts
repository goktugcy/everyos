import type { InstalledAppView, Permission } from "@everyos/shared";
import type { WindowSpec } from "@everyos/window-manager";
import { getApp, isAppAllowed } from "../apps/registry.ts";
import { useAiAgents } from "../apps/ai-agents/agent-store.ts";
import type { AppId, DesktopAppManifest } from "../apps/types.ts";
import type { SettingsSection } from "../commands.tsx";
import { usePreferences } from "./preferences-store.ts";
import { wm } from "./window-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { api } from "../../lib/api.ts";
import { installationId, rememberInstalledApps } from "../apps/store/installed-apps-store.ts";
import { appLaunchLinks } from "../apps/store/launch-links.ts";

function permissions(): readonly Permission[] {
  return useSessionStore.getState().session?.permissions ?? [];
}

export function specFor(manifest: DesktopAppManifest): WindowSpec {
  return {
    appId: manifest.id,
    // Empty title = use the localized app name; apps may set a custom title.
    title: "",
    defaultSize: manifest.window.defaultSize,
    minSize: manifest.window.minSize,
    instancing: manifest.window.instancing,
  };
}

/** Resolves persisted windows on restore; unknown or forbidden apps are dropped. */
export function resolveSpec(appId: string): WindowSpec | null {
  if (installationId(appId)) return null;
  const manifest = getApp(appId);
  return manifest && isAppAllowed(manifest, permissions()) ? specFor(manifest) : null;
}

/**
 * The desktop's app-level API (docs/contracts.md §1–2): every way of opening
 * an app (icons, dock, launcher, menus, shortcuts) goes through here.
 */
export const desktop = {
  openApp(
    appId: AppId,
    options: { appState?: unknown; newInstance?: boolean } = {},
  ): string | null {
    const manifest = getApp(appId);
    if (!manifest || !isAppAllowed(manifest, permissions())) return null;
    const installedId = installationId(appId);
    if (installedId && manifest.installedApp) {
      const nativeChat = useAiAgents
        .getState()
        .agents.find((agent) => agent.settings.mode === "managed" && agent.app?.id === installedId);
      if (nativeChat)
        return desktop.openApp("everyos.agents", { appState: { kind: nativeChat.kind } });
      const sessionId = useSessionStore.getState().session?.session.id;
      // Reserve the tab during the user gesture, then resolve current published ports.
      const popup = appLaunchLinks(manifest.installedApp, window.location.hostname).length
        ? window.open("about:blank", "_blank")
        : null;
      if (popup) popup.opener = null;
      void api<{ apps: InstalledAppView[] }>("/apps")
        .then(({ apps }) => {
          if (
            useSessionStore.getState().session?.session.id !== sessionId ||
            useSessionStore.getState().locked ||
            !permissions().includes("apps:read")
          ) {
            popup?.close();
            return;
          }
          rememberInstalledApps(apps);
          const app = apps.find((entry) => entry.id === installedId);
          const link = app && appLaunchLinks(app, window.location.hostname)[0];
          if (link && popup && !popup.closed) popup.location.replace(link.href);
          else {
            popup?.close();
            desktop.openApp("everyos.applications", { appState: { applicationId: installedId } });
          }
        })
        .catch(() => {
          popup?.close();
          if (
            useSessionStore.getState().session?.session.id === sessionId &&
            !useSessionStore.getState().locked
          )
            desktop.openApp("everyos.applications", { appState: { applicationId: installedId } });
        });
      return null;
    }
    return wm().open(specFor(manifest), options);
  },
  openWindow(appId: AppId, appState?: unknown): string | null {
    return desktop.openApp(appId, {
      newInstance: true,
      ...(appState !== undefined ? { appState } : {}),
    });
  },
  focusWindow: (id: string) => wm().focus(id),
  minimizeWindow: (id: string) => wm().minimize(id),
  closeWindow: (id: string) => wm().close(id),
  openSettings(section: SettingsSection, extra: Record<string, unknown> = {}) {
    desktop.openApp("everyos.settings", { appState: { ...extra, section } });
  },
  /** Ids of the virtual desktops in order (from preferences). */
  desktopIds(): string[] {
    return usePreferences.getState().desktop.desktops.map((d) => d.id);
  },
  switchDesktopBy(step: 1 | -1) {
    const ids = desktop.desktopIds();
    const index = ids.indexOf(wm().activeDesktopId);
    const next = ids[(index + step + ids.length) % ids.length];
    if (next) wm().switchDesktop(next);
  },
};
