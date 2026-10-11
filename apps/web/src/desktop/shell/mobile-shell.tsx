import { DEFAULT_WALLPAPER_PRESET_ID } from "@everyos/theme";
import { ChevronLeft, Lock, LogOut, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../../components/brand/logo.tsx";
import { Clock } from "../../features/shell/clock.tsx";
import { usePermissions, useSessionStore } from "../../stores/session-store.ts";
import { AppHostContext, type AppHost } from "../apps/app-context.ts";
import { AppIcon } from "../apps/app-icon.tsx";
import { allowedApps, getApp } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";
import { searchEntries } from "../launcher/search.ts";
import { LockScreen } from "../lock/lock-screen.tsx";
import { useAutoLock } from "../lock/use-auto-lock.ts";
import { ConfirmHost } from "../menus/confirm.tsx";
import { useThemeStore } from "../theme/theme-store.ts";
import { WallpaperView } from "../wallpaper/wallpaper-view.tsx";
import { AppContent } from "../windows/app-content.tsx";

interface OpenApp {
  appId: AppId;
  appState: unknown;
  title: string;
}

/**
 * Phones get a launcher and one full-screen app at a time instead of
 * overlapping windows; apps are the same components as on the desktop.
 */
export function MobileShell() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const user = useSessionStore((state) => state.session?.user);
  const locked = useSessionStore((state) => state.locked);
  const lock = useSessionStore((state) => state.lock);
  const signOut = useSessionStore((state) => state.signOut);
  const theme = useThemeStore((state) => state.theme);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<OpenApp | null>(null);
  useAutoLock();

  const apps = useMemo(
    () => allowedApps(permissions).map((app) => ({ ...app, title: t(app.titleKey) })),
    [permissions, t],
  );
  const visible = searchEntries(
    apps.map((app) => ({ ...app, id: app.id, keywords: app.keywords ?? [] })),
    query,
    50,
  );

  const host = useMemo<AppHost | null>(
    () =>
      open
        ? {
            windowId: "mobile",
            appState: open.appState,
            setAppState: (appState) =>
              setOpen((current) => (current ? { ...current, appState } : current)),
            setTitle: (title) => setOpen((current) => (current ? { ...current, title } : current)),
            close: () => setOpen(null),
          }
        : null,
    [open],
  );
  const manifest = open ? getApp(open.appId) : undefined;

  return (
    <>
      <div
        className="fixed inset-0 flex flex-col overflow-hidden"
        inert={locked}
        data-testid="mobile-shell"
      >
        <WallpaperView
          spec={theme.wallpaper}
          fallback={{ kind: "preset", id: DEFAULT_WALLPAPER_PRESET_ID }}
        />
        <header className="glass-strong relative z-10 flex h-12 shrink-0 items-center gap-2 rounded-none border-x-0 border-t-0 px-3 pt-[env(safe-area-inset-top)]">
          {open && manifest ? (
            <>
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="flex h-9 items-center gap-1 rounded-everyos-sm pr-2 text-sm text-fg hover:bg-hover/10"
                aria-label={t("mobile.back")}
              >
                <ChevronLeft className="size-5" aria-hidden />
                {t("mobile.home")}
              </button>
              <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
                {open.title || t(manifest.titleKey)}
              </h1>
              <span className="w-16" />
            </>
          ) : (
            <>
              <LogoMark className="size-6" />
              <span className="font-semibold">{t("brand.name")}</span>
              <span className="ml-auto text-sm text-fg-muted">
                <Clock />
              </span>
            </>
          )}
        </header>

        {open && host ? (
          <main className="glass-strong relative z-10 m-0 min-h-0 flex-1 rounded-none border-0">
            <AppHostContext.Provider value={host}>
              <AppContent appId={open.appId} />
            </AppHostContext.Provider>
          </main>
        ) : (
          <main className="relative z-10 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <p className="text-2xl font-semibold tracking-tight drop-shadow">
              {t("shell.welcome", { name: user?.displayName ?? "" })}
            </p>
            <label className="glass flex h-11 items-center gap-2 rounded-everyos-md px-3">
              <Search className="size-4 text-fg-subtle" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("launcher.placeholder")}
                aria-label={t("launcher.placeholder")}
                className="h-full w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
            </label>
            <ul className="grid grid-cols-4 gap-x-2 gap-y-5" aria-label={t("launcher.apps")}>
              {visible.map((app) => (
                <li key={app.id}>
                  <button
                    type="button"
                    onClick={() => setOpen({ appId: app.id, appState: undefined, title: "" })}
                    className="flex w-full flex-col items-center gap-1.5 rounded-everyos-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <AppIcon manifest={app} size={56} />
                    <span
                      className="max-w-full truncate rounded-md px-1.5 text-[0.72rem] font-medium text-fg"
                      style={{
                        background: "rgb(var(--everyos-surface) / var(--everyos-surface-opacity))",
                      }}
                    >
                      {app.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-auto grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => void lock()}
                className="glass flex h-11 items-center justify-center gap-2 rounded-everyos-md text-sm"
              >
                <Lock className="size-4" aria-hidden />
                {t("quickSettings.lock")}
              </button>
              <button
                type="button"
                onClick={() => void signOut()}
                className="glass flex h-11 items-center justify-center gap-2 rounded-everyos-md text-sm"
              >
                <LogOut className="size-4" aria-hidden />
                {t("shell.menu.signOut")}
              </button>
            </div>
          </main>
        )}
        <ConfirmHost />
      </div>
      {locked ? <LockScreen /> : null}
    </>
  );
}
