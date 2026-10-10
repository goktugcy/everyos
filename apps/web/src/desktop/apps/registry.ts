import type { Permission } from "@otuken/shared";
import {
  Activity,
  Boxes,
  Container,
  Folder,
  Gauge,
  ScrollText,
  Settings,
  Store,
  Users,
} from "lucide-react";
import type { AppId, DesktopAppManifest } from "./types.ts";

/** Built-in apps. Later phases register Files, Terminal and the App Store here. */
export const APP_MANIFESTS: readonly DesktopAppManifest[] = [
  {
    id: "otuken.store",
    titleKey: "apps.store",
    icon: Store,
    tint: "from-emerald-400 to-teal-600",
    category: "tools",
    requiredPermission: "apps:read",
    window: {
      defaultSize: { width: 1040, height: 740 },
      minSize: { width: 420, height: 360 },
      instancing: "single",
    },
    keywords: [
      "uygulama",
      "mağaza",
      "app",
      "store",
      "catalog",
      "katalog",
      "casaos",
      "big bear",
      "runtipi",
      "coolify",
      "portainer",
    ],
    load: () => import("./store/store-app.tsx"),
  },
  {
    id: "otuken.system",
    titleKey: "apps.system",
    icon: Gauge,
    tint: "from-sky-400 to-indigo-500",
    category: "system",
    requiredPermission: "system:read",
    window: {
      defaultSize: { width: 980, height: 720 },
      minSize: { width: 420, height: 360 },
      instancing: "single",
    },
    keywords: [
      "sistem",
      "system",
      "izleyici",
      "monitor",
      "donanım",
      "hardware",
      "cpu",
      "işlemci",
      "bellek",
      "memory",
      "disk",
      "depolama",
      "storage",
      "ağ",
      "network",
      "tailscale",
      "işlemler",
      "processes",
      "sıcaklık",
      "temperature",
    ],
    load: () => import("./system/system-app.tsx"),
  },
  {
    id: "otuken.docker",
    titleKey: "apps.docker",
    icon: Container,
    tint: "from-sky-500 to-blue-700",
    category: "system",
    requiredPermission: "docker:read",
    requiredCapability: "docker",
    window: {
      defaultSize: { width: 1100, height: 720 },
      minSize: { width: 420, height: 360 },
      instancing: "single",
    },
    keywords: [
      "docker",
      "konteyner",
      "container",
      "compose",
      "imaj",
      "image",
      "volume",
      "ağ",
      "network",
    ],
    load: () => import("./docker/docker-app.tsx"),
  },
  {
    id: "otuken.services",
    titleKey: "apps.services",
    icon: Boxes,
    tint: "from-violet-400 to-fuchsia-600",
    category: "system",
    requiredPermission: "services:read",
    requiredCapability: "systemd",
    window: {
      defaultSize: { width: 1000, height: 640 },
      minSize: { width: 420, height: 360 },
      instancing: "single",
    },
    keywords: ["servisler", "services", "systemd", "birimler", "units", "daemon"],
    load: () => import("./services/services-app.tsx"),
  },
  {
    id: "otuken.logs",
    titleKey: "apps.logs",
    icon: ScrollText,
    tint: "from-zinc-400 to-zinc-600",
    category: "system",
    requiredPermission: "logs:read",
    requiredCapability: "journald",
    window: {
      defaultSize: { width: 1000, height: 640 },
      minSize: { width: 420, height: 320 },
      instancing: "single",
    },
    keywords: ["günlükler", "logs", "journal", "journald", "kayıtlar", "hata", "errors"],
    load: () => import("./logs/logs-app.tsx"),
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
