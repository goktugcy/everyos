import type { Messages } from "@everyos/i18n";
import type { CapabilityId, InstalledAppView, Permission } from "@everyos/shared";
import type { WindowSpec } from "@everyos/window-manager";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { InstalledAppId } from "./store/installed-apps-store.ts";

export type AppId =
  | InstalledAppId
  | "everyos.homeassistant"
  | "everyos.system"
  | "everyos.services"
  | "everyos.logs"
  | "everyos.docker"
  | "everyos.store"
  | "everyos.applications"
  | "everyos.settings"
  | "everyos.users"
  | "everyos.audit"
  | "everyos.files"
  | "everyos.trash"
  | "everyos.editor"
  | "everyos.updates"
  | "everyos.tasks"
  | "everyos.terminal"
  | "everyos.backups"
  | "everyos.tailscale";

/**
 * Contract every built-in EveryOS app fulfils (docs/contracts.md §1). The
 * component is imported lazily the first time a window of the app opens.
 */
export interface DesktopAppManifest {
  id: AppId;
  installedApp?: InstalledAppView;
  titleKey: `apps.${keyof Messages["apps"]}`;
  icon: LucideIcon;
  /** Tailwind gradient classes for the icon tile. */
  tint: string;
  category: "system" | "tools" | "settings";
  /** UI hint only; the API enforces the same permission independently. */
  requiredPermission?: Permission;
  requiredCapability?: CapabilityId;
  window: Pick<WindowSpec, "defaultSize" | "minSize" | "instancing">;
  /** Hidden apps (e.g. folders) are not listed in the launcher or dock menus. */
  hidden?: boolean;
  /** Extra search terms (both languages) for the launcher. */
  keywords?: string[];
  load: () => Promise<{ default: ComponentType }>;
}
