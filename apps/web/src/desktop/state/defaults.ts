import type {
  DesktopPreferences,
  DockPreferences,
  MenubarPreferences,
  PulsePreferences,
  NotificationPreferences,
  Permission,
  SecurityPreferences,
} from "@otuken/shared";
import type { TFunction } from "i18next";
import { allowedApps } from "../apps/registry.ts";
import { newId } from "./ids.ts";

export function defaultDesktop(
  t: TFunction,
  permissions: readonly Permission[],
): DesktopPreferences {
  const desktopId = newId("d");
  return {
    version: 1,
    desktops: [{ id: desktopId, name: t("desktop.defaultName", { n: 1 }), wallpaper: null }],
    items: allowedApps(permissions).map((app, index) => ({
      kind: "app" as const,
      id: newId("i"),
      appId: app.id,
      desktopId,
      cell: { col: 0, row: index },
      folderId: null,
    })),
    files: [],
  };
}

export function defaultDock(permissions: readonly Permission[]): DockPreferences {
  return {
    version: 1,
    pinned: allowedApps(permissions).map((app) => app.id),
    style: "floating",
    position: "bottom",
    iconSize: 48,
    magnification: true,
    autoHide: false,
    opacity: 1,
  };
}

export const DEFAULT_MENUBAR: MenubarPreferences = { version: 1, hidden: [], clockSeconds: false };

export const DEFAULT_SECURITY: SecurityPreferences = { version: 1, autoLockMinutes: 0 };

/** The pulse is shown and opens on hover; the shelf starts empty. */
export const DEFAULT_PULSE: PulsePreferences = {
  version: 1,
  enabled: true,
  openOnHover: true,
  destination: null,
  shelf: [],
};

/** Pop-ups for warnings and worse; nothing muted. */
export const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  version: 1,
  toasts: true,
  toastMinSeverity: "warning",
  mutedCategories: [],
};
