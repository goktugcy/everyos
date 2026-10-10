import {
  THEME_PRESET_IDS,
  WALLPAPER_PRESET_IDS,
  type CustomTheme,
  type ThemeEffects,
  type WallpaperPresetId,
  type WallpaperSpec,
} from "@otuken/shared";
import { isHexColor } from "./color.ts";

/**
 * Portable theme files. Only declarative values are exchanged; uploaded
 * image wallpapers are dropped because they are private to one server.
 * Imported files are validated field by field here (the browser does not
 * ship zod) and validated again by the API when saved.
 */
export const THEME_FILE_FORMAT = "otuken-theme";
export const THEME_FILE_VERSION = 1;

export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT;
  schemaVersion: typeof THEME_FILE_VERSION;
  theme: Omit<CustomTheme, "id">;
}

export function exportTheme(theme: CustomTheme): string {
  const file: ThemeFile = {
    format: THEME_FILE_FORMAT,
    schemaVersion: THEME_FILE_VERSION,
    theme: {
      name: theme.name,
      base: theme.base,
      accent: theme.accent,
      effects: theme.effects,
      wallpaper: theme.wallpaper?.kind === "image" ? null : theme.wallpaper,
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ThemeImportError =
  "not-json" | "wrong-format" | "unsupported-version" | "invalid-field";

const EFFECT_RANGES: Record<keyof ThemeEffects, [number, number]> = {
  surfaceOpacity: [0.3, 1],
  blur: [0, 40],
  borderIntensity: [0, 1],
  shadowIntensity: [0, 1],
  radius: [4, 32],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWallpaper(value: unknown): WallpaperSpec | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (value.kind === "preset" && (WALLPAPER_PRESET_IDS as readonly unknown[]).includes(value.id)) {
    return { kind: "preset", id: value.id as WallpaperPresetId };
  }
  if (value.kind === "solid" && isHexColor(value.color))
    return { kind: "solid", color: value.color };
  if (
    value.kind === "gradient" &&
    isHexColor(value.from) &&
    isHexColor(value.to) &&
    typeof value.angle === "number" &&
    Number.isInteger(value.angle) &&
    value.angle >= 0 &&
    value.angle <= 360
  ) {
    return { kind: "gradient", from: value.from, to: value.to, angle: value.angle };
  }
  return undefined;
}

export function importTheme(
  text: string,
  newId: string,
): { ok: true; theme: CustomTheme } | { ok: false; error: ThemeImportError } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }
  if (!isRecord(raw) || raw.format !== THEME_FILE_FORMAT || !isRecord(raw.theme)) {
    return { ok: false, error: "wrong-format" };
  }
  if (raw.schemaVersion !== THEME_FILE_VERSION) return { ok: false, error: "unsupported-version" };
  const theme = raw.theme;

  const name = typeof theme.name === "string" ? theme.name.trim() : "";
  if (name.length < 1 || name.length > 40) return { ok: false, error: "invalid-field" };
  if (!(THEME_PRESET_IDS as readonly unknown[]).includes(theme.base))
    return { ok: false, error: "invalid-field" };
  if (!isHexColor(theme.accent)) return { ok: false, error: "invalid-field" };
  if (!isRecord(theme.effects)) return { ok: false, error: "invalid-field" };

  const effects: Partial<ThemeEffects> = {};
  for (const [key, value] of Object.entries(theme.effects)) {
    const range = EFFECT_RANGES[key as keyof ThemeEffects] as [number, number] | undefined;
    if (
      !range ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < range[0] ||
      value > range[1]
    ) {
      return { ok: false, error: "invalid-field" };
    }
    effects[key as keyof ThemeEffects] = value;
  }
  const wallpaper = parseWallpaper(theme.wallpaper ?? null);
  if (wallpaper === undefined) return { ok: false, error: "invalid-field" };

  return {
    ok: true,
    theme: {
      id: newId,
      name,
      base: theme.base as CustomTheme["base"],
      accent: theme.accent.toLowerCase(),
      effects,
      wallpaper,
    },
  };
}
