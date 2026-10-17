import type { MenubarModuleId } from "@everyos/shared";
import { useState, type ReactNode } from "react";
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
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../../components/brand/logo.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { cn } from "../../lib/cn.ts";
import { usePermissions, useSessionStore } from "../../stores/session-store.ts";
import { Clock } from "../../features/shell/clock.tsx";
import { getApp } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";
import { useLauncher } from "../launcher/launcher-store.ts";
import type { MenuEntry } from "../menus/menu-model.ts";
import { ContextMenuArea, MenuDropdown } from "../menus/menus.tsx";
import { desktop } from "../state/controller.ts";
import { addDesktop } from "../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { useWindowManager, wm } from "../state/window-store.ts";
import { useAgentStatus, useAgentStatusPolling } from "./agent-status.ts";
import { menubarButton } from "./menubar-button.ts";
import { QuickSettings } from "./quick-settings.tsx";
import { NetworkModule, PowerModule, ResourcesModule } from "./system-modules.tsx";
import { MenubarWidgets } from "../widgets/menubar-widgets.tsx";
import { NotificationBell } from "../notifications/center.tsx";
import { MenubarCustomization } from "./customization.tsx";
import { moduleOrder, moduleVisibility } from "./module-order.ts";
import { DEFAULT_MENUBAR } from "../state/defaults.ts";
import { ConnectionModule } from "./connection-module.tsx";
import { AiAgentModule } from "./ai-agent-module.tsx";
import { powerMenuEntries } from "../power/power.tsx";

function AgentIndicator() {
  const { t } = useTranslation();
  useAgentStatusPolling();
  const agent = useAgentStatus((state) => state.agent);
  if (agent === null) return null;
  const connected = agent === "connected";
  const label = connected ? t("agent.connected") : t("agent.unavailable");
  // A status dot like macOS menu extras; the problem state also gets a word.
  return (
    <span
      role="status"
      className="flex h-[26px] items-center gap-1.5 px-1.5 text-[0.75rem]"
      title={label}
      aria-label={label}
      data-testid="agent-status"
    >
      <span
        className={cn(
          "size-[7px] rounded-full",
          connected ? "bg-success shadow-[0_0_6px_rgb(var(--everyos-success)/0.8)]" : "bg-danger",
        )}
        aria-hidden
      />
      {connected ? null : <span className="text-danger">{label}</span>}
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
            "grid h-[22px] min-w-[22px] place-items-center rounded-[5px] px-1 text-[0.7rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-accent",
            entry.id === active ? "bg-hover/25 text-fg" : "text-fg-muted hover:bg-hover/15",
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
          className="grid size-[22px] place-items-center rounded-[5px] text-fg-muted outline-none hover:bg-hover/15 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
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

export function Menubar() {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const signOut = useSessionStore((state) => state.signOut);
  const lock = useSessionStore((state) => state.lock);
  const preferences = usePreferences((state) => state.menubar);
  const { hidden, clockSeconds } = preferences;
  const [customizing, setCustomizing] = useState(false);
  const openLauncher = useLauncher((state) => state.open);
  const focused = useWindowManager((state) =>
    state.focusedId ? state.windows[state.focusedId] : undefined,
  );
  const show = (module: MenubarModuleId) => !hidden.includes(module);
  const permissions = usePermissions();
  const canReadSystem = permissions.includes("system:read");
  const canCustomize = permissions.includes("preferences:manage");
  const contextMenu = (): MenuEntry[] => [
    {
      kind: "item",
      id: "customize",
      label: t("menubar.customize"),
      icon: <Settings />,
      permission: "preferences:manage",
      onSelect: () => setCustomizing(true),
    },
    {
      kind: "submenu",
      id: "visible",
      label: t("menubar.visibleItems"),
      permission: "preferences:manage",
      entries: moduleOrder(preferences.order).map((id) => ({
        kind: "check",
        id,
        label: t(`settings.desktop.menubarModules.${id}`),
        checked: show(id),
        onCheckedChange: (visible) =>
          updatePreference("menubar", (doc) => moduleVisibility(doc, id, visible)),
      })),
    },
    ...(canCustomize
      ? [
          {
            kind: "check" as const,
            id: "seconds",
            label: t("settings.desktop.clockSeconds"),
            checked: clockSeconds,
            onCheckedChange: (value: boolean) =>
              updatePreference("menubar", (doc) => ({ ...doc, clockSeconds: value })),
          },
        ]
      : []),
    {
      kind: "item",
      id: "reset",
      label: t("menubar.reset"),
      permission: "preferences:manage",
      onSelect: () => updatePreference("menubar", () => DEFAULT_MENUBAR),
    },
  ];

  const focusedApp = focused ? getApp(focused.appId) : undefined;
  const everyosMenu: MenuEntry[] = [
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
      onSelect: () => desktop.openApp("everyos.settings"),
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
    { kind: "separator", id: "s3" },
    ...powerMenuEntries(t),
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

  const modules: Record<MenubarModuleId, ReactNode> = {
    widgets: <MenubarWidgets />,
    notifications: <NotificationBell />,
    resources: canReadSystem ? <ResourcesModule /> : null,
    power: canReadSystem ? <PowerModule /> : null,
    network: canReadSystem ? <NetworkModule /> : null,
    agent: <AgentIndicator />,
    aiAgents:
      permissions.includes("terminal:access") && permissions.includes("apps:manage") ? (
        <AiAgentModule />
      ) : null,
    desktops: <DesktopSwitcher />,
    search: (
      <button
        type="button"
        className={menubarButton}
        aria-label={t("common.search")}
        title={`${t("common.search")} (Ctrl+K)`}
        onClick={openLauncher}
      >
        <Search className="size-4" aria-hidden />
      </button>
    ),
    quickSettings: <QuickSettings />,
    clock: (
      <span
        className="whitespace-nowrap px-2 text-[0.82rem] font-medium"
        data-testid="menubar-clock"
      >
        <Clock seconds={clockSeconds} />
      </span>
    ),
  };

  return (
    <>
      <ContextMenuArea entries={contextMenu}>
        <header
          data-testid="menubar"
          tabIndex={0}
          aria-label={t("settings.desktop.menubar")}
          className="menubar-glass fixed inset-x-0 top-0 z-[70] flex h-[var(--everyos-menubar-height)] items-center gap-0.5 px-2.5 pt-[env(safe-area-inset-top)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <MenuDropdown
            label={t("shell.menu.label")}
            entries={everyosMenu}
            trigger={
              <button type="button" className={cn(menubarButton, "px-2.5")}>
                <LogoMark className="!size-[17px]" />
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

          <ConnectionModule />
          <div className="ml-auto flex items-center gap-0.5">
            {moduleOrder(preferences.order).map((id) =>
              show(id) && modules[id] ? (
                <div key={id} className="contents" data-menubar-module={id}>
                  {modules[id]}
                </div>
              ) : null,
            )}
            {user ? (
              <MenuDropdown
                align="end"
                label={t("shell.userMenu")}
                entries={userMenu}
                trigger={
                  <button
                    type="button"
                    className="ml-1 grid size-[22px] place-items-center rounded-full button-accent text-[0.6rem] font-bold [text-shadow:none] outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {initials(user.displayName)}
                  </button>
                }
              />
            ) : null}
          </div>
        </header>
      </ContextMenuArea>
      {customizing ? (
        <Dialog open onOpenChange={setCustomizing} title={t("menubar.customize")}>
          <MenubarCustomization />
        </Dialog>
      ) : null}
    </>
  );
}
