import { AppWindow, MonitorUp, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { workArea } from "@everyos/window-manager";
import type { DesktopAppInstallationView } from "@everyos/shared";
import { uninstallDesktopApp } from "../desktop-apps/uninstall.ts";
import { useDesktopApps, refreshDesktopApps } from "../desktop-apps/store.ts";
import { requestConfirm } from "../menus/confirm.tsx";
import type { MenuEntry } from "../menus/menu-model.ts";
import { desktop } from "../state/controller.ts";
import { addShortcut } from "../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { useWindowManager, wm } from "../state/window-store.ts";
import { gridMetrics } from "../surface/icon-grid.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import { appTitle } from "./app-title.ts";
import { getApp } from "./registry.ts";
import type { AppId } from "./types.ts";

/** Shared actions for built-in and installed SDK apps in the launcher and Applications folder. */
export function useAppMenu(onChanged?: () => void) {
  const { t, i18n } = useTranslation();
  const dock = usePreferences((state) => state.dock);
  const desktopDoc = usePreferences((state) => state.desktop);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const viewport = useWindowManager((state) => state.viewport);
  const iconSize = useThemeStore((state) => state.theme.iconSize);
  const desktopApps = useDesktopApps();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const menu = (id: string, installation?: DesktopAppInstallationView): MenuEntry[] => {
    const manifest = getApp(id);
    const app = manifest?.desktopApp ?? installation;
    if (!manifest && !app) return [];
    const name = manifest
      ? appTitle(manifest, t, i18n.language)
      : (desktopApps.names[app!.appId] ?? app!.name);
    const pinned = dock.pinned.includes(id);
    const onDesktop = desktopDoc.items.some(
      (item) =>
        item.kind === "app" &&
        item.appId === id &&
        item.desktopId === activeDesktopId &&
        item.folderId === null,
    );
    const changed = () => {
      setError(null);
      onChanged?.();
    };
    const entries: MenuEntry[] = [
      {
        kind: "item",
        id: "open",
        label: t("common.open"),
        icon: <AppWindow />,
        disabled: !manifest,
        onSelect: () => {
          desktop.openApp(id as AppId);
          changed();
        },
      },
      {
        kind: "item",
        id: "desktop",
        label: t("applications.menu.addDesktop"),
        icon: <MonitorUp />,
        permission: "preferences:manage",
        disabled: !manifest || onDesktop || desktopDoc.items.length >= 300,
        onSelect: () => {
          updatePreference("desktop", (doc) =>
            addShortcut(doc, id, wm().activeDesktopId, gridMetrics(iconSize, workArea(viewport))),
          );
          changed();
        },
      },
      {
        kind: "item",
        id: "dock",
        label: pinned ? t("dock.unpin") : t("applications.menu.pinDock"),
        icon: pinned ? <PinOff /> : <Pin />,
        permission: "preferences:manage",
        disabled: !manifest || (!pinned && dock.pinned.length >= 32),
        onSelect: () => {
          updatePreference("dock", (doc) => ({
            ...doc,
            pinned: doc.pinned.includes(id)
              ? doc.pinned.filter((entry) => entry !== id)
              : doc.pinned.length < 32
                ? [...doc.pinned, id]
                : doc.pinned,
          }));
          changed();
        },
      },
    ];
    if (app) {
      const uninstall = async () => {
        if (
          pending ||
          !(await requestConfirm({
            title: t("desktopApps.store.uninstallTitle", { name }),
            body: t("desktopApps.store.uninstallBody"),
            confirmLabel: t("desktopApps.store.uninstall"),
            danger: true,
          }))
        )
          return;
        setPending(id);
        setError(null);
        try {
          await uninstallDesktopApp(app.appId);
          await refreshDesktopApps();
          changed();
        } catch (caught) {
          setError(caught);
        } finally {
          setPending(null);
        }
      };
      entries.push(
        { kind: "separator", id: "manage" },
        {
          kind: "item",
          id: "uninstall",
          label: t("desktopApps.store.uninstall"),
          icon: <Trash2 />,
          permission: "apps:manage",
          danger: true,
          disabled: pending !== null,
          onSelect: () => void uninstall(),
        },
      );
    }
    return entries;
  };
  return { menu, error };
}
