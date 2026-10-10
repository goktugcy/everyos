import type { WallpaperPresetId } from "@otuken/shared";

/**
 * Built-in wallpapers are generated with CSS gradients (no image assets), so
 * they cost nothing to download and scale to any resolution. `colors` drive
 * both the rendering and the contrast guarantees of the theme engine.
 */
export interface WallpaperPreset {
  id: WallpaperPresetId;
  scheme: "dark" | "light";
  style: "dusk" | "aurora" | "mesh" | "flat";
  colors: { base: string; a: string; b: string; c: string };
  /** Peak opacity of the glow layers over the base color. */
  glow: number;
  ridges: "dark" | "light" | null;
  animatable: boolean;
}

export const WALLPAPER_PRESETS: Record<WallpaperPresetId, WallpaperPreset> = {
  "otuken-dusk": {
    id: "otuken-dusk",
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
