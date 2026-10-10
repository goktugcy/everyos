/*
 * Per-user preference documents (zod-free constants). The matching runtime
 * schemas live in "@otuken/shared/schemas" (schemas/preferences.ts) and the
 * document types are re-exported from the package root.
 */

/** Preference documents stored per user, each saved independently. */
export const PREFERENCE_KEYS = [
  "appearance",
  "desktop",
  "dock",
  "menubar",
  "windows",
  "security",
  "widgets",
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const THEME_PRESET_IDS = [
  "liquid-dark",
  "frost-blue",
  "graphite-glass",
  "aurora",
  "minimal-clear",
  "neon-night",
  "liquid-light",
] as const;

export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

export const WALLPAPER_PRESET_IDS = [
  "otuken-dusk",
  "aurora",
  "frost",
  "graphite",
  "neon",
  "minimal",
  "daylight",
] as const;

export type WallpaperPresetId = (typeof WALLPAPER_PRESET_IDS)[number];

/**
 * Rendering presets trade visual richness for CPU/GPU cost on the viewing
 * device. "performance" disables blur, wallpaper animation and window
 * animations entirely.
 */
export const RENDER_MODES = ["performance", "balanced", "premium"] as const;

export type RenderMode = (typeof RENDER_MODES)[number];

export const WINDOW_ANIMATIONS = ["none", "fade", "scale"] as const;

export type WindowAnimation = (typeof WINDOW_ANIMATIONS)[number];

export const ICON_SIZES = ["small", "medium", "large"] as const;

export type IconSize = (typeof ICON_SIZES)[number];

export const DOCK_STYLES = ["floating", "taskbar", "hybrid"] as const;

export type DockStyle = (typeof DOCK_STYLES)[number];

export const DOCK_POSITIONS = ["bottom", "left", "right"] as const;

export type DockPosition = (typeof DOCK_POSITIONS)[number];

/** Menu bar modules that can be shown or hidden individually. */
export const MENUBAR_MODULE_IDS = [
  "widgets",
  "resources",
  "network",
  "agent",
  "desktops",
  "search",
  "quickSettings",
  "clock",
] as const;

export type MenubarModuleId = (typeof MENUBAR_MODULE_IDS)[number];

export const SNAP_ZONES = [
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export type SnapZone = (typeof SNAP_ZONES)[number];

export const WINDOW_LAYOUTS = ["floating", "maximized", "fullscreen", ...SNAP_ZONES] as const;

export type WindowLayout = (typeof WINDOW_LAYOUTS)[number];

export const AUTO_LOCK_MINUTES = [0, 5, 15, 30, 60] as const;

export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES)[number];

export const MAX_DESKTOPS = 8;
export const MAX_WALLPAPERS_PER_USER = 20;
export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
export const WALLPAPER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type WallpaperMimeType = (typeof WALLPAPER_MIME_TYPES)[number];

export interface WallpaperInfo {
  id: string;
  mime: WallpaperMimeType;
  size: number;
  width: number;
  height: number;
  createdAt: number;
}

export function isPreferenceKey(value: unknown): value is PreferenceKey {
  return typeof value === "string" && (PREFERENCE_KEYS as readonly string[]).includes(value);
}
