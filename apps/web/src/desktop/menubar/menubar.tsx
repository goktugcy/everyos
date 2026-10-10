import type { MenubarModuleId } from "@otuken/shared";
import {
  AppWindow,
  Copy,
  Info,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  LogOut,
  Minimize2,
  Minus,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../../components/brand/logo.tsx";
import { cn } from "../../lib/cn.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { Clock } from "../../features/shell/clock.tsx";
import { getApp } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";
import { useLauncher } from "../launcher/launcher-store.ts";
import type { MenuEntry } from "../menus/menu-model.ts";
import { MenuDropdown } from "../menus/menus.tsx";
import { desktop } from "../state/controller.ts";
import { addDesktop } from "../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { useWindowManager, wm } from "../state/window-store.ts";
import { useAgentStatus, useAgentStatusPolling } from "./agent-status.ts";
import { menubarButton } from "./menubar-button.ts";
import { QuickSettings } from "./quick-settings.tsx";

function AgentIndicator() {
  const { t } = useTranslation();
  useAgentStatusPolling();
  const agent = useAgentStatus((state) => state.agent);
  if (agent === null) return null;
  const connected = agent === "connected";
  return (
    <span
      className="flex items-center gap-1.5 px-1.5 text-[0.75rem] text-fg-muted"
      title={connected ? t("agent.connected") : t("agent.unavailable")}
      data-testid="agent-status"
    >
      <span
        className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-danger")}
        aria-hidden
      />
      <span className="hidden lg:inline">
        {connected ? t("agent.connected") : t("agent.unavailable")}
      </span>
    </span>
  );
}

function DesktopSwitcher() {
  const { t } = useTranslation();
  const desktops = usePreferences((state) => state.desktop.desktops);
  const active = useWindowManager((state) => state.activeDesktopId);
  return (
    <div role="group" aria-label={t("menubar.desktops")} className="flex items-center gap-0.5">
      {desktops.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          aria-label={t("menubar.switchDesktop", { name: entry.name })}
          aria-pressed={entry.id === active}
          title={entry.name}
          onClick={() => wm().switchDesktop(entry.id)}
          className={cn(
            "grid h-6 min-w-6 place-items-center rounded-md px-1 text-[0.7rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-accent",
            entry.id === active
              ? "bg-[rgb(var(--otk-accent)/0.28)] text-fg"
              : "text-fg-muted hover:bg-hover/10",
          )}
        >
          {index + 1}
        </button>
      ))}
      {desktops.length < 8 ? (
        <button
          type="button"
          aria-label={t("menubar.addDesktop")}
          title={t("menubar.addDesktop")}
          onClick={() => {
            let created: string | null = null;
            updatePreference("desktop", (doc) => {
              const result = addDesktop(
                doc,
                t("desktop.defaultName", { n: doc.desktops.length + 1 }),
              );
              created = result.id;
              return result.doc;
            });
            if (created) wm().switchDesktop(created);
          }}
          className="grid size-6 place-items-center rounded-md text-fg-subtle outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase("tr"))
      .join("") || "?"
  );
}

export function Menubar({ insecure }: { insecure: boolean }) {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const signOut = useSessionStore((state) => state.signOut);
  const lock = useSessionStore((state) => state.lock);
  const hidden = usePreferences((state) => state.menubar.hidden);
  const clockSeconds = usePreferences((state) => state.menubar.clockSeconds);
  const openLauncher = useLauncher((state) => state.open);
  const focused = useWindowManager((state) =>
    state.focusedId ? state.windows[state.focusedId] : undefined,
  );
  const show = (module: MenubarModuleId) => !hidden.includes(module);

  const focusedApp = focused ? getApp(focused.appId) : undefined;
  const otukenMenu: MenuEntry[] = [
    {
      kind: "item",
      id: "about",
      label: t("shell.menu.about"),
      icon: <Info />,
      onSelect: () => desktop.openSettings("about"),
    },
    {
      kind: "item",
      id: "settings",
      label: t("menubar.settings"),
      icon: <Settings />,
      onSelect: () => desktop.openApp("otuken.settings"),
    },
    { kind: "separator", id: "s1" },
    {
      kind: "item",
      id: "launcher",
      label: t("dock.launcher"),
      icon: <LayoutGrid />,
      shortcut: "Ctrl+K",
      onSelect: openLauncher,
    },
    { kind: "separator", id: "s2" },
    {
      kind: "item",
      id: "lock",
      label: t("menubar.lock"),
      icon: <Lock />,
      shortcut: "Ctrl+Alt+L",
      onSelect: () => void lock(),
    },
    {
      kind: "item",
      id: "signout",
      label: t("shell.menu.signOut"),
      icon: <LogOut />,
      onSelect: () => void signOut(),
    },
  ];
  const windowMenu: MenuEntry[] = [
    ...(focused && focusedApp?.window.instancing === "multiple"
      ? [
          {
            kind: "item" as const,
            id: "new",
            label: t("menubar.newWindow"),
            icon: <AppWindow />,
            onSelect: () => desktop.openWindow(focused.appId as AppId),
          },
        ]
      : []),
    {
      kind: "item",
      id: "min",
      label: t("menubar.minimize"),
      icon: <Minus />,
      shortcut: "Ctrl+Alt+↓",
      disabled: !focused,
      onSelect: () => focused && wm().minimize(focused.id),
    },
    {
      kind: "item",
      id: "max",
      label: t("menubar.toggleMaximize"),
      icon: <Copy />,
      shortcut: "Ctrl+Alt+↑",
      disabled: !focused,
      onSelect: () => focused && wm().toggleMaximize(focused.id),
    },
    { kind: "separator", id: "s1" },
    {
      kind: "item",
      id: "tile",
      label: t("menubar.tile"),
      icon: <LayoutDashboard />,
      shortcut: "Ctrl+Alt+T",
      onSelect: () => wm().tile("columns"),
    },
    {
      kind: "item",
      id: "grid",
      label: t("menubar.tileGrid"),
      icon: <LayoutGrid />,
      onSelect: () => wm().tile("grid"),
    },
    {
      kind: "item",
      id: "minall",
      label: t("menubar.minimizeAll"),
      icon: <Minimize2 />,
      onSelect: () => wm().minimizeAll(),
    },
    { kind: "separator", id: "s2" },
    {
      kind: "item",
      id: "close",
      label: t("menubar.closeWindow"),
      icon: <X />,
      shortcut: "Ctrl+Alt+W",
      disabled: !focused,
      onSelect: () => focused && wm().close(focused.id),
    },
  ];
  const userMenu: MenuEntry[] = user
    ? [
        {
          kind: "label",
          id: "who",
          label: `${user.displayName} · @${user.username} · ${t(`roles.${user.role}`)}`,
        },
        { kind: "separator", id: "s0" },
        {
          kind: "item",
          id: "account",
          label: t("settings.sections.account"),
          icon: <UserRound />,
          onSelect: () => desktop.openSettings("account"),
        },
        {
          kind: "item",
          id: "security",
          label: t("settings.sections.security"),
          icon: <ShieldCheck />,
          onSelect: () => desktop.openSettings("security"),
        },
        { kind: "separator", id: "s1" },
        {
          kind: "item",
          id: "lock",
          label: t("menubar.lock"),
          icon: <Lock />,
          onSelect: () => void lock(),
        },
        {
          kind: "item",
          id: "signout",
          label: t("shell.menu.signOut"),
          icon: <LogOut />,
          onSelect: () => void signOut(),
        },
      ]
    : [];

  return (
    <header
      data-testid="menubar"
      className="glass-strong fixed inset-x-0 top-0 z-[70] flex h-[var(--otk-menubar-height)] items-center gap-1 rounded-none border-x-0 border-t-0 px-2 pt-[env(safe-area-inset-top)]"
    >
      <MenuDropdown
        label={t("shell.menu.label")}
        entries={otukenMenu}
        trigger={
          <button type="button" className={cn(menubarButton, "font-semibold")}>
            <LogoMark className="size-[18px]" />
            <span className="hidden sm:inline">{t("brand.name")}</span>
          </button>
        }
      />
      <MenuDropdown
        label={t("menubar.windowMenu")}
        entries={windowMenu}
        trigger={
          <button
            type="button"
            className={cn(menubarButton, "font-semibold")}
            data-testid="menubar-app"
          >
            {focusedApp ? focused?.title || t(focusedApp.titleKey) : t("desktop.workspace")}
          </button>
        }
      />

      <div className="ml-auto flex items-center gap-1">
        {insecure ? (
          <span
            className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[0.75rem] text-warning"
            title={t("transport.insecureBody")}
          >
            <ShieldAlert className="size-3.5" aria-hidden />
            <span className="hidden md:inline">{t("transport.insecureTitle")}</span>
          </span>
        ) : null}
        {show("agent") ? <AgentIndicator /> : null}
        {show("desktops") ? <DesktopSwitcher /> : null}
        {show("search") ? (
          <button
            type="button"
            className={menubarButton}
            aria-label={t("common.search")}
            title={`${t("common.search")} (Ctrl+K)`}
            onClick={openLauncher}
          >
            <Search className="size-4" aria-hidden />
          </button>
        ) : null}
        {show("quickSettings") ? <QuickSettings /> : null}
        {show("clock") ? (
          <span className="px-1.5 text-[0.8rem] text-fg-muted" data-testid="menubar-clock">
            <Clock seconds={clockSeconds} />
          </span>
        ) : null}
        {user ? (
          <MenuDropdown
            align="end"
            label={t("shell.userMenu")}
            entries={userMenu}
            trigger={
              <button
                type="button"
                className="ml-0.5 grid size-7 place-items-center rounded-full button-accent text-[0.68rem] font-bold outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {initials(user.displayName)}
              </button>
            }
          />
        ) : null}
      </div>
    </header>
  );
}
