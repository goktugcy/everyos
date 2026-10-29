import { DEFAULT_WALLPAPER_PRESET_ID } from "@everyos/theme";
import { i18next } from "../../app/i18n.ts";
import { clearDesktopApps, loadDesktopApps } from "../desktop-apps/store.ts";
import { reassignDesktops } from "@everyos/widget-sdk";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../../components/brand/logo.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { useMediaQuery } from "../../lib/use-media-query.ts";
import { errorMessage } from "../../lib/errors.ts";
import { registerBeforeSignOut, useSessionStore } from "../../stores/session-store.ts";
import { getApp, isAppAllowed } from "../apps/registry.ts";
import { TrashStatusProvider } from "../apps/files/trash-status.tsx";
import { useAiAgentPolling } from "../apps/ai-agents/agent-store.ts";
import {
  clearInstalledApps,
  installationId,
  rememberInstalledApps,
  useInstalledApps,
} from "../apps/store/installed-apps-store.ts";
import type { InstalledAppView } from "@everyos/shared";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { Dock } from "../dock/dock.tsx";
import { Launcher } from "../launcher/launcher.tsx";
import { LockScreen } from "../lock/lock-screen.tsx";
import { useAutoLock } from "../lock/use-auto-lock.ts";
import { ConfirmHost } from "../menus/confirm.tsx";
import { PowerHost } from "../power/power.tsx";
import { DiskDialogHost, useLiveDisksStream } from "../../features/disks/disks.tsx";
import { useTransfersStream } from "../../features/transfers/transfers-stream.ts";
import { useDriveAccountLoader, useDriveConsentReturn } from "../../features/drive/drive.ts";
import { Menubar } from "../menubar/menubar.tsx";
import { useDesktopShortcuts } from "../shortcuts.ts";
import { desktop, resolveSpec } from "../state/controller.ts";
import { pruneUnavailable } from "../state/desktop-ops.ts";
import {
  discardPending,
  flushPending,
  flushPreferences,
  loadPreferences,
  scheduleSave,
  updatePreference,
  usePreferences,
} from "../state/preferences-store.ts";
import {
  computeInsets,
  measureViewport,
  useWindowManager,
  windowManager,
  wm,
} from "../state/window-store.ts";
import { DesktopSurface } from "../surface/desktop-surface.tsx";
import { useThemeStore } from "../theme/theme-store.ts";
import { WallpaperView } from "../wallpaper/wallpaper-view.tsx";
import { WidgetDesktopLayer } from "../widgets/desktop-layer.tsx";
import { WidgetHost } from "../widgets/host.tsx";
import { NotificationToasts } from "../notifications/toasts.tsx";
import { useNotificationStream } from "../notifications/store.ts";
import { Pulse } from "../pulse/pulse.tsx";
import { WindowLayer } from "../windows/window-layer.tsx";
import { MobileShell } from "./mobile-shell.tsx";
import { useUpdateReload } from "../../features/updates/use-update-reload.ts";

/** Restores the window session once and keeps the viewport in sync. */
function useWindowSession(): void {
  const dock = usePreferences((state) => state.dock);
  const sidebarOpen = usePreferences((state) => state.widgets.sidebar.open);

  useEffect(() => {
    const { initialWindows, desktop } = usePreferences.getState();
    const preferences = usePreferences.getState();
    wm().setViewport(
      measureViewport(computeInsets(preferences.dock, preferences.widgets.sidebar.open)),
    );
    const desktopIds = desktop.desktops.map((d) => d.id);
    if (initialWindows) {
      wm().hydrate(initialWindows, resolveSpec);
      usePreferences.setState({ initialWindows: null });
    }
    // Windows on desktops that no longer exist move to the first desktop.
    for (const window of Object.values(wm().windows)) {
      if (!desktopIds.includes(window.desktopId)) wm().moveToDesktop(window.id, desktopIds[0]!);
    }
    if (!desktopIds.includes(wm().activeDesktopId)) wm().switchDesktop(desktopIds[0]!);

    // Persist the window layout (debounced) whenever it changes.
    let last = JSON.stringify(wm().serialize());
    const unsubscribe = windowManager.subscribe(() => {
      const next = JSON.stringify(wm().serialize());
      if (next === last) return;
      last = next;
      scheduleSave("windows", () => wm().serialize(), 1_000);
    });
    const onHide = () => {
      if (document.visibilityState === "hidden") flushPreferences();
    };
    window.addEventListener("pagehide", flushPreferences);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flushPreferences);
      document.removeEventListener("visibilitychange", onHide);
      flushPreferences();
    };
  }, []);

  useEffect(() => {
    const update = () => wm().setViewport(measureViewport(computeInsets(dock, sidebarOpen)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [dock, sidebarOpen]);
}

function DesktopWorkspace() {
  const { t } = useTranslation();
  const locked = useSessionStore((state) => state.locked);
  const saveError = usePreferences((state) => state.saveError);
  const theme = useThemeStore((state) => state.theme);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const desktopWallpaper = usePreferences(
    (state) => state.desktop.desktops.find((d) => d.id === activeDesktopId)?.wallpaper ?? null,
  );
  useWindowSession();
  useDesktopShortcuts();
  useAutoLock();

  const pulse = usePreferences((state) => state.pulse.enabled);
  return (
    <>
      <div className="fixed inset-0 overflow-hidden" inert={locked} data-testid="desktop">
        <WallpaperView
          spec={desktopWallpaper ?? theme.wallpaper}
          fallback={{ kind: "preset", id: DEFAULT_WALLPAPER_PRESET_ID }}
        />
        <DesktopSurface />
        <WidgetDesktopLayer />
        <WindowLayer />
        <WidgetHost />
        <Menubar />
        {/* Hidden on narrow screens, where it would cover menu bar items. */}
        {pulse ? (
          <div className="hidden min-[1100px]:contents">
            <Pulse />
          </div>
        ) : null}
        <Dock />
        <Launcher />
        <ConfirmHost />
        <PowerHost />
        <DiskDialogHost />
        {saveError ? (
          <div className="fixed right-3 top-12 z-[75] w-80">
            <Alert tone="warning">{t("common.saveFailed")}</Alert>
          </div>
        ) : null}
      </div>
      {locked ? <LockScreen /> : null}
    </>
  );
}

/**
 * The signed-in experience: loads per-user preferences, then shows the full
 * desktop on wide screens or the simplified launcher on phones.
 */
export function DesktopShell() {
  useAiAgentPolling();
  const { t } = useTranslation();
  const ready = usePreferences((state) => state.ready);
  const permissions = useSessionStore((state) => state.session?.permissions);
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const locked = useSessionStore((state) => state.locked);
  const mobile = useMediaQuery("(max-width: 767px)");
  useUpdateReload(ready && !locked && Boolean(permissions?.includes("system:read")));
  useNotificationStream(ready && !locked && Boolean(permissions?.includes("notifications:read")));
  useLiveDisksStream(ready && !locked && Boolean(permissions?.includes("system:read")));
  useTransfersStream(ready && !locked && Boolean(permissions?.includes("files:read")));
  useDriveAccountLoader(ready && !locked && Boolean(permissions?.includes("files:read")));
  useDriveConsentReturn(ready && !locked && Boolean(permissions?.includes("files:read")), () =>
    desktop.openSettings("connections"),
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const desktopDoc = usePreferences((state) => state.desktop);
  const pinned = usePreferences((state) => state.dock.pinned);
  const installed = useInstalledApps();
  const installedShortcutIds = [
    ...pinned,
    ...desktopDoc.items.flatMap((item) => (item.kind === "app" ? [item.appId] : [])),
  ]
    .filter((id) => installationId(id))
    .sort()
    .join(",");
  const lastListing = useRef<{ apps: InstalledAppView[] } | null>(null);
  const canReadApps = Boolean(permissions?.includes("apps:read"));
  const watchInstalled = ready && !locked && canReadApps && installedShortcutIds.length > 0;
  const installedResource = useApiResource<{ apps: InstalledAppView[] }>(
    watchInstalled ? "/apps" : null,
    5000,
    installedShortcutIds,
  );

  useEffect(() => {
    // Do not replay the resource's previous listing when polling resumes for a new shortcut.
    if (
      watchInstalled &&
      installedResource.data &&
      !installedResource.error &&
      installedResource.data !== lastListing.current
    ) {
      lastListing.current = installedResource.data;
      rememberInstalledApps(installedResource.data.apps);
    }
  }, [watchInstalled, installedResource.data, installedResource.error]);

  useEffect(() => {
    if (!ready || locked || !permissions) return;
    if (!canReadApps && (installed.loaded || installed.apps.length)) clearInstalledApps();
    // A failed/offline listing must never erase persisted shortcuts.
    if (canReadApps && !installed.loaded) return;
    const available = (id: string) =>
      !installationId(id) ||
      (canReadApps && installed.apps.some((app) => app.id === installationId(id)));
    const current = usePreferences.getState();
    if (pruneUnavailable(current.desktop, available) !== current.desktop)
      updatePreference("desktop", (doc) => pruneUnavailable(doc, available));
    if (current.dock.pinned.some((id) => !available(id)))
      updatePreference("dock", (doc) => ({ ...doc, pinned: doc.pinned.filter(available) }));
  }, [ready, locked, permissions, canReadApps, installed]);

  useEffect(() => {
    if (!permissions || ready || locked) return;
    const controller = new AbortController();
    // Desktop apps first: restoring windows and shortcuts needs to know which apps are installed.
    // A failed listing leaves them out for this session rather than blocking the desktop.
    void (
      permissions.includes("apps:read")
        ? loadDesktopApps(i18next.language, controller.signal).catch(() => undefined)
        : Promise.resolve()
    )
      .then(() => loadPreferences({ t, permissions }, controller.signal))
      .then(() => {
        if (controller.signal.aborted) return;
        // Drop shortcuts to apps this user can no longer open (e.g. after a role change).
        const available = (appId: string) => {
          if (installationId(appId)) return permissions.includes("apps:read");
          const manifest = getApp(appId);
          return Boolean(manifest && isAppAllowed(manifest, permissions));
        };
        const current = usePreferences.getState().desktop;
        if (pruneUnavailable(current, available) !== current) {
          updatePreference("desktop", (doc) => pruneUnavailable(doc, available));
        }
        const desktopIds = usePreferences.getState().desktop.desktops.map((d) => d.id);
        const widgets = usePreferences.getState().widgets;
        if (reassignDesktops(widgets, desktopIds) !== widgets) {
          updatePreference("widgets", (doc) => reassignDesktops(doc, desktopIds));
          // Saves a default desktop layout so its ids stay stable from now on.
          updatePreference("desktop", (doc) => doc);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error);
      });
    return () => controller.abort();
  }, [t, permissions, sessionId, ready, locked, attempt]);

  useEffect(() => {
    const unregister = registerBeforeSignOut(flushPending);
    return () => {
      unregister();
      discardPending();
      clearInstalledApps();
      clearDesktopApps();
      wm().hydrate(
        { version: 1, viewport: { width: 1, height: 1 }, activeDesktopId: "d1", windows: [] },
        () => null,
      );
      usePreferences.setState({ ready: false, initialWindows: null });
    };
  }, [sessionId]);

  if (!ready) {
    if (locked) return <LockScreen />;
    if (loadError) {
      return (
        <div className="flex min-h-dvh items-center justify-center p-6">
          <div className="glass-strong flex max-w-md flex-col gap-4 rounded-everyos-lg p-6">
            <Alert tone="danger">{errorMessage(t, loadError)}</Alert>
            <Button
              onClick={() => {
                setLoadError(null);
                setAttempt((value) => value + 1);
              }}
            >
              {t("common.retry")}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-dvh items-center justify-center gap-4">
        <LogoMark className="size-12" />
        <Spinner className="size-5 text-fg-subtle" label={t("common.loading")} />
      </div>
    );
  }
  return (
    <TrashStatusProvider key={sessionId}>
      {mobile ? <MobileShell /> : <DesktopWorkspace />}
      {!locked ? <NotificationToasts /> : null}
    </TrashStatusProvider>
  );
}
