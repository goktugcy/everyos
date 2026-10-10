import type { Messages } from "@otuken/i18n";
import type { CapabilityId, Permission } from "@otuken/shared";
import type { WindowSpec } from "@otuken/window-manager";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export type AppId =
  "otuken.system" | "otuken.settings" | "otuken.users" | "otuken.audit" | "otuken.folder";

/**
 * Contract every built-in Otuken app fulfils (docs/contracts.md §1). The
 * component is imported lazily the first time a window of the app opens.
 */
export interface DesktopAppManifest {
  id: AppId;
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
