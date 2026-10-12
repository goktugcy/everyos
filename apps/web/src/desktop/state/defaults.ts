import type {
  DesktopPreferences,
  DockPreferences,
  MenubarPreferences,
  PulsePreferences,
  NotificationPreferences,
  Permission,
  SecurityPreferences,
} from "@everyos/shared";
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
    applicationsFolderAdded: permissions.includes("apps:read"),
  };
}

/** Add the new folder once, preserving custom layouts and later user removal. */
export function withApplicationsFolder(
  doc: DesktopPreferences,
  permissions: readonly Permission[],
): DesktopPreferences {
  if (doc.applicationsFolderAdded || !permissions.includes("apps:read")) return doc;
  if (doc.items.some((item) => item.kind === "app" && item.appId === "everyos.applications"))
    return { ...doc, applicationsFolderAdded: true };
  if (doc.items.length >= 300) return doc;
  return {
    ...doc,
    applicationsFolderAdded: true,
    items: [
      ...doc.items,
      {
        kind: "app",
        id: newId("i"),
        appId: "everyos.applications",
        desktopId: doc.desktops[0]!.id,
        cell: null,
        folderId: null,
      },
    ],
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
