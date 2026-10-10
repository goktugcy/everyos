import { RENDER_MODES, THEME_PRESET_IDS } from "@otuken/shared";
import type { TFunction } from "i18next";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Gauge,
  LayoutDashboard,
  Lock,
  LogOut,
  Minimize2,
  Palette,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { useSessionStore } from "../stores/session-store.ts";
import { desktop } from "./state/controller.ts";
import { updatePreference } from "./state/preferences-store.ts";
import { wm } from "./state/window-store.ts";

export interface DesktopCommand {
  id: string;
  title: string;
  keywords: string[];
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

export const SETTINGS_SECTIONS = [
  "appearance",
  "desktop",
  "widgets",
  "account",
  "security",
  "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Global commands offered by the launcher (and reused by keyboard shortcuts). */
export function buildCommands(t: TFunction): DesktopCommand[] {
  const session = useSessionStore.getState();
  return [
    {
      id: "lock",
      title: t("commands.lock"),
      keywords: ["lock", "kilit"],
      icon: <Lock />,
      shortcut: "Ctrl+Alt+L",
      run: () => void session.lock(),
    },
    {
      id: "sign-out",
      title: t("commands.signOut"),
      keywords: ["logout", "çıkış", "sign out"],
      icon: <LogOut />,
      run: () => void session.signOut(),
    },
    {
      id: "tile",
      title: t("commands.tile"),
      keywords: ["tile", "döşe", "yan yana"],
      icon: <LayoutDashboard />,
      shortcut: "Ctrl+Alt+T",
      run: () => wm().tile("columns"),
    },
    {
      id: "minimize-all",
      title: t("commands.minimizeAll"),
      keywords: ["minimize", "küçült", "masaüstünü göster", "show desktop"],
      icon: <Minimize2 />,
      run: () => wm().minimizeAll(),
    },
    {
      id: "next-desktop",
      title: t("commands.nextDesktop"),
      keywords: ["desktop", "masaüstü"],
      icon: <ArrowRightToLine />,
      shortcut: "Ctrl+Alt+PageDown",
      run: () => desktop.switchDesktopBy(1),
    },
    {
      id: "previous-desktop",
      title: t("commands.previousDesktop"),
      keywords: ["desktop", "masaüstü"],
      icon: <ArrowLeftToLine />,
      shortcut: "Ctrl+Alt+PageUp",
      run: () => desktop.switchDesktopBy(-1),
    },
    ...THEME_PRESET_IDS.map((id) => ({
      id: `theme-${id}`,
      title: t("commands.theme", { name: t(`themes.${id}`) }),
      keywords: ["theme", "tema", "görünüm", "appearance"],
      icon: <Palette />,
      run: () =>
        updatePreference("appearance", (current) => ({ ...current, themeId: id, accent: null })),
    })),
    ...RENDER_MODES.map((mode) => ({
      id: `render-${mode}`,
      title: t("commands.renderMode", { name: t(`renderModes.${mode}`) }),
      keywords: ["performance", "performans", "quality", "kalite"],
      icon: <Gauge />,
      run: () => updatePreference("appearance", (current) => ({ ...current, renderMode: mode })),
    })),
    ...SETTINGS_SECTIONS.map((section) => ({
      id: `settings-${section}`,
      title: t("commands.settingsSection", { name: t(`settings.sections.${section}`) }),
      keywords: ["settings", "ayarlar"],
      icon: <Settings />,
      run: () => desktop.openSettings(section),
    })),
  ];
}
