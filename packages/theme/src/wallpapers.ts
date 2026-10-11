import type { WallpaperPresetId } from "@everyos/shared";

/**
 * Built-in wallpapers use CSS gradients or a bundled image. `colors` describe
 * the CSS rendering/fallback; image presets use worst-case contrast bounds.
 */
export interface WallpaperPreset {
  id: WallpaperPresetId;
  scheme: "dark" | "light";
  style: "dusk" | "aurora" | "mesh" | "flat";
  /** Local public asset; the CSS style remains a fallback if it cannot load. */
  image?: string;
  colors: { base: string; a: string; b: string; c: string };
  /** Peak opacity of the glow layers over the base color. */
  glow: number;
  ridges: "dark" | "light" | null;
  animatable: boolean;
}

export const DEFAULT_WALLPAPER_PRESET_ID: WallpaperPresetId = "everyos-mountains";

export const WALLPAPER_PRESETS: Record<WallpaperPresetId, WallpaperPreset> = {
  "everyos-mountains": {
    id: "everyos-mountains",
    scheme: "dark",
    style: "flat",
    image: "/wallpapers/everyos-mountains.png",
    colors: { base: "#06171b", a: "#153b44", b: "#356873", c: "#82a6a9" },
    glow: 0.4,
    ridges: null,
    animatable: false,
  },
  "everyos-dusk": {
    id: "everyos-dusk",
    scheme: "dark",
    style: "dusk",
    colors: { base: "#070b18", a: "#38bdf8", b: "#6366f1", c: "#10b981" },
    glow: 0.55,
    ridges: "dark",
    animatable: true,
  },
  aurora: {
    id: "aurora",
    scheme: "dark",
    style: "aurora",
    colors: { base: "#03101a", a: "#2dd4bf", b: "#a78bfa", c: "#22c55e" },
    glow: 0.5,
    ridges: "dark",
    animatable: true,
  },
  frost: {
    id: "frost",
    scheme: "dark",
    style: "mesh",
    colors: { base: "#081428", a: "#93c5fd", b: "#3b82f6", c: "#bae6fd" },
    glow: 0.45,
    ridges: null,
    animatable: true,
  },
  graphite: {
    id: "graphite",
    scheme: "dark",
    style: "mesh",
    colors: { base: "#0b0b0d", a: "#52525b", b: "#3f3f46", c: "#71717a" },
    glow: 0.5,
    ridges: null,
    animatable: false,
  },
  neon: {
    id: "neon",
    scheme: "dark",
    style: "mesh",
    colors: { base: "#07040f", a: "#ec4899", b: "#06b6d4", c: "#8b5cf6" },
    glow: 0.5,
    ridges: null,
    animatable: true,
  },
  minimal: {
    id: "minimal",
    scheme: "light",
    style: "flat",
    colors: { base: "#e9eef4", a: "#cbd5e1", b: "#f1f5f9", c: "#e2e8f0" },
    glow: 0.6,
    ridges: null,
    animatable: false,
  },
  daylight: {
    id: "daylight",
    scheme: "light",
    style: "dusk",
    colors: { base: "#dbe8f6", a: "#93c5fd", b: "#c4b5fd", c: "#fde68a" },
    glow: 0.6,
    ridges: "light",
    animatable: true,
  },
};
