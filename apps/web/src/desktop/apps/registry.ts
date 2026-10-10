import type { Permission } from "@otuken/shared";
import { Activity, Folder, Gauge, Settings, Users } from "lucide-react";
import type { AppId, DesktopAppManifest } from "./types.ts";

/** Built-in apps. Later phases register Docker, Services, Logs, Files, Terminal and the App Store here. */
export const APP_MANIFESTS: readonly DesktopAppManifest[] = [
  {
    id: "otuken.system",
    titleKey: "apps.system",
    icon: Gauge,
    tint: "from-sky-400 to-indigo-500",
    category: "system",
    requiredPermission: "system:read",
    window: {
      defaultSize: { width: 760, height: 640 },
      minSize: { width: 420, height: 360 },
      instancing: "single",
    },
    keywords: ["sistem", "system", "donanım", "hardware", "cpu", "bellek", "memory"],
    load: () => import("./system/system-app.tsx"),
  },
  {
    id: "otuken.settings",
    titleKey: "apps.settings",
    icon: Settings,
    tint: "from-slate-400 to-slate-600",
    category: "settings",
    window: {
      defaultSize: { width: 980, height: 680 },
      minSize: { width: 560, height: 420 },
      instancing: "single",
    },
    keywords: [
      "ayarlar",
      "settings",
      "tema",
      "theme",
      "görünüm",
      "appearance",
      "duvar kağıdı",
      "wallpaper",
      "güvenlik",
      "security",
    ],
    load: () => import("./settings/settings-app.tsx"),
  },
  {
    id: "otuken.users",
    titleKey: "apps.users",
    icon: Users,
    tint: "from-emerald-400 to-teal-600",
    category: "settings",
    requiredPermission: "users:manage",
    window: {
      defaultSize: { width: 900, height: 600 },
      minSize: { width: 560, height: 380 },
      instancing: "single",
    },
    keywords: ["kullanıcılar", "users", "hesaplar", "accounts", "roller", "roles"],
    load: () => import("./users/users-app.tsx"),
  },
  {
    id: "otuken.audit",
    titleKey: "apps.audit",
    icon: Activity,
    tint: "from-amber-400 to-orange-600",
    category: "tools",
    requiredPermission: "audit:read",
    window: {
      defaultSize: { width: 980, height: 620 },
      minSize: { width: 560, height: 360 },
      instancing: "single",
    },
    keywords: ["denetim", "audit", "kayıt", "log", "güvenlik", "security"],
    load: () => import("./audit/audit-app.tsx"),
  },
  {
    id: "otuken.folder",
    titleKey: "apps.folder",
    icon: Folder,
    tint: "from-sky-300 to-sky-500",
    category: "tools",
    hidden: true,
    window: {
      defaultSize: { width: 560, height: 400 },
      minSize: { width: 320, height: 240 },
      instancing: "multiple",
    },
    load: () => import("./folder/folder-app.tsx"),
  },
];

const BY_ID = new Map(APP_MANIFESTS.map((manifest) => [manifest.id, manifest]));

export function getApp(id: string): DesktopAppManifest | undefined {
  return BY_ID.get(id as AppId);
}

export function isAppAllowed(
  manifest: DesktopAppManifest,
  permissions: readonly Permission[],
): boolean {
  return !manifest.requiredPermission || permissions.includes(manifest.requiredPermission);
}

/** Apps the user may see, in registry order. */
export function allowedApps(
  permissions: readonly Permission[],
  options: { includeHidden?: boolean } = {},
): DesktopAppManifest[] {
  return APP_MANIFESTS.filter(
    (manifest) =>
      isAppAllowed(manifest, permissions) && (options.includeHidden || !manifest.hidden),
  );
}
