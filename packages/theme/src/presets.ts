import type { ThemeEffects, ThemePresetId, WallpaperPresetId } from "@everyos/shared";
import { DEFAULT_WALLPAPER_PRESET_ID } from "./wallpapers.ts";

export interface ThemePalette {
  scheme: "dark" | "light";
  accent: string;
  accentStrong: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  surface: string;
  border: string;
  danger: string;
  success: string;
  warning: string;
}

export interface ThemePreset {
  id: ThemePresetId;
  palette: ThemePalette;
  effects: ThemeEffects;
  wallpaper: WallpaperPresetId;
}

const DARK_STATUS = { danger: "#fb7185", success: "#34d399", warning: "#fbbf24" };
const LIGHT_STATUS = { danger: "#b91c1c", success: "#047857", warning: "#92400e" };

export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  "liquid-dark": {
    id: "liquid-dark",
    palette: {
      scheme: "dark",
      accent: "#7dd3fc",
      accentStrong: "#6384ff",
      text: "#f1f5fb",
      textMuted: "#cbd5e6",
      textSubtle: "#a3b1c9",
      surface: "#101626",
      border: "#ffffff",
      ...DARK_STATUS,
    },
    effects: {
      surfaceOpacity: 0.6,
      blur: 22,
      borderIntensity: 0.4,
      shadowIntensity: 0.55,
      radius: 22,
    },
    wallpaper: DEFAULT_WALLPAPER_PRESET_ID,
  },
  "frost-blue": {
    id: "frost-blue",
    palette: {
      scheme: "dark",
      accent: "#93c5fd",
      accentStrong: "#5b8cff",
      text: "#f3f8ff",
      textMuted: "#d0ddf2",
      textSubtle: "#a7b9d6",
      surface: "#0c1a30",
      border: "#dbeafe",
      ...DARK_STATUS,
    },
    effects: {
      surfaceOpacity: 0.58,
      blur: 26,
      borderIntensity: 0.5,
      shadowIntensity: 0.5,
      radius: 20,
    },
    wallpaper: "frost",
  },
  "graphite-glass": {
    id: "graphite-glass",
    palette: {
      scheme: "dark",
      accent: "#e4e4e7",
      accentStrong: "#a1a1aa",
      text: "#f4f4f5",
      textMuted: "#d4d4d8",
      textSubtle: "#a9a9b2",
      surface: "#17181b",
      border: "#ffffff",
      ...DARK_STATUS,
    },
    effects: {
      surfaceOpacity: 0.7,
      blur: 18,
      borderIntensity: 0.35,
      shadowIntensity: 0.6,
      radius: 14,
    },
    wallpaper: "graphite",
  },
  aurora: {
    id: "aurora",
    palette: {
      scheme: "dark",
      accent: "#5eead4",
      accentStrong: "#a78bfa",
      text: "#effcf8",
      textMuted: "#c9e7df",
      textSubtle: "#9dc2bb",
      surface: "#0b1722",
      border: "#ccfbf1",
      ...DARK_STATUS,
    },
    effects: {
      surfaceOpacity: 0.56,
      blur: 24,
      borderIntensity: 0.4,
      shadowIntensity: 0.5,
      radius: 24,
    },
    wallpaper: "aurora",
  },
  "minimal-clear": {
    id: "minimal-clear",
    palette: {
      scheme: "light",
      accent: "#2563eb",
      accentStrong: "#1d4ed8",
      text: "#0f172a",
      textMuted: "#334155",
      textSubtle: "#526075",
      surface: "#ffffff",
      border: "#0f172a",
      ...LIGHT_STATUS,
    },
    effects: {
      surfaceOpacity: 0.82,
      blur: 12,
      borderIntensity: 0.35,
      shadowIntensity: 0.18,
      radius: 12,
    },
    wallpaper: "minimal",
  },
  "neon-night": {
    id: "neon-night",
    palette: {
      scheme: "dark",
      accent: "#f472b6",
      accentStrong: "#22d3ee",
      text: "#fcf6ff",
      textMuted: "#e2d3f3",
      textSubtle: "#b7a3cf",
      surface: "#120c22",
      border: "#f5d0fe",
      ...DARK_STATUS,
    },
    effects: {
      surfaceOpacity: 0.62,
      blur: 20,
      borderIntensity: 0.45,
      shadowIntensity: 0.6,
      radius: 18,
    },
    wallpaper: "neon",
  },
  "liquid-light": {
    id: "liquid-light",
    palette: {
      scheme: "light",
      accent: "#0284c7",
      accentStrong: "#4f46e5",
      text: "#0b1220",
      textMuted: "#2f3c52",
      textSubtle: "#4f5d73",
      surface: "#f8fafc",
      border: "#0f172a",
      ...LIGHT_STATUS,
    },
    effects: {
      surfaceOpacity: 0.66,
      blur: 24,
      borderIntensity: 0.3,
      shadowIntensity: 0.22,
      radius: 22,
    },
    wallpaper: "daylight",
  },
};
