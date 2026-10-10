import type {
  AppearancePreferences,
  CustomTheme,
  IconSize,
  RenderMode,
  ThemeEffects,
  WallpaperSpec,
  WindowAnimation,
} from "@otuken/shared";
import { BLACK, composite, contrastRatio, mix, parseHex, toHex, WHITE, type Rgb } from "./color.ts";
import { THEME_PRESETS, type ThemePalette } from "./presets.ts";
import { WALLPAPER_PRESETS } from "./wallpapers.ts";

/** WCAG AA for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;
const DARK_TEXT: Rgb = parseHex("#0b1020");

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 1,
  themeId: "liquid-dark",
  accent: null,
  effects: {},
  fontScale: 1,
  iconSize: "medium",
  renderMode: "balanced",
  windowAnimation: "scale",
  wallpaper: null,
  wallpaperAnimated: true,
  customThemes: [],
};

export interface ResolvedTheme {
  id: string;
  scheme: "dark" | "light";
  palette: ThemePalette;
  /** Text color used on accent-colored controls (buttons). */
  accentContrast: string;
  /** Primary button gradient, adjusted when needed so its label stays readable. */
  button: { from: string; to: string };
  effects: ThemeEffects;
  /** Lowest surface opacity that keeps text readable over this wallpaper. */
  minReadableOpacity: number;
  renderMode: RenderMode;
  windowAnimation: WindowAnimation;
  wallpaper: WallpaperSpec;
  wallpaperAnimated: boolean;
  fontScale: number;
  iconSize: IconSize;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The colors a glass surface may end up on top of. Built-in wallpapers have
 * known colors; for gradients the endpoints matter; for uploaded images the
 * worst case (pure white and pure black) is assumed.
 */
export function wallpaperBackdrops(wallpaper: WallpaperSpec): Rgb[] {
  switch (wallpaper.kind) {
    case "preset": {
      const preset = WALLPAPER_PRESETS[wallpaper.id];
      const base = parseHex(preset.colors.base);
      return [
        base,
        ...[preset.colors.a, preset.colors.b, preset.colors.c].map((c) =>
          composite(parseHex(c), preset.glow, base),
        ),
      ];
    }
    case "gradient":
      return [
        parseHex(wallpaper.from),
        parseHex(wallpaper.to),
        mix(parseHex(wallpaper.from), parseHex(wallpaper.to), 0.5),
      ];
    case "solid":
      return [parseHex(wallpaper.color)];
    case "image":
      return [WHITE, BLACK];
  }
}

/** Contrast of `text` on a glass surface of the given opacity over each backdrop (worst case). */
export function surfaceContrast(
  text: string,
  surface: string,
  opacity: number,
  backdrops: Rgb[],
): number {
  const fg = parseHex(text);
  const bg = parseHex(surface);
  return Math.min(
    ...backdrops.map((backdrop) => contrastRatio(fg, composite(bg, opacity, backdrop))),
  );
}

/**
 * Smallest surface opacity at which every text tone of the palette meets
 * WCAG AA on every backdrop. User opacity settings are clamped to this value,
 * so customization can never make text unreadable.
 */
export function minReadableOpacity(palette: ThemePalette, backdrops: Rgb[]): number {
  const ok = (opacity: number) =>
    [palette.text, palette.textMuted, palette.textSubtle].every(
      (tone) => surfaceContrast(tone, palette.surface, opacity, backdrops) >= MIN_TEXT_CONTRAST,
    );
  if (ok(0.3)) return 0.3;
  let low = 0.3;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const middle = (low + high) / 2;
    if (ok(middle)) high = middle;
    else low = middle;
  }
  return Math.ceil(high * 100) / 100;
}

function pickContrastText(colors: Rgb[]): Rgb {
  const worst = (text: Rgb) => Math.min(...colors.map((c) => contrastRatio(text, c)));
  return worst(DARK_TEXT) >= worst(WHITE) ? DARK_TEXT : WHITE;
}

/** Moves `color` away from `text` until the pair reaches the target contrast. */
function ensureContrast(color: Rgb, text: Rgb, target = MIN_TEXT_CONTRAST): Rgb {
  const toward = text === WHITE ? BLACK : WHITE;
  let adjusted = color;
  for (let step = 0; step < 20 && contrastRatio(adjusted, text) < target; step++) {
    adjusted = mix(adjusted, toward, 0.08);
  }
  return adjusted;
}

function accentColors(accent: string, accentStrong: string) {
  const from = parseHex(accent);
  const to = parseHex(accentStrong);
  const text = pickContrastText([from, to]);
  return {
    accentContrast: toHex(text),
    button: { from: toHex(ensureContrast(from, text)), to: toHex(ensureContrast(to, text)) },
  };
}

/** Derives a second gradient stop for a user-chosen accent color. */
function deriveAccentStrong(accent: string): string {
  const color = parseHex(accent);
  const text = pickContrastText([color]);
  return toHex(text === WHITE ? mix(color, BLACK, 0.2) : mix(color, WHITE, 0.18));
}

/** Applies partial overrides in order, ignoring absent (undefined) values. */
function mergeEffects(
  base: ThemeEffects,
  ...overrides: Array<{ [K in keyof ThemeEffects]?: number | undefined } | undefined>
): ThemeEffects {
  const out = { ...base };
  for (const override of overrides) {
    if (!override) continue;
    for (const key of Object.keys(out) as Array<keyof ThemeEffects>) {
      const value = override[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

function findCustom(settings: AppearancePreferences): CustomTheme | null {
  if (!settings.themeId.startsWith("custom:")) return null;
  const id = settings.themeId.slice("custom:".length);
  return settings.customThemes.find((theme) => theme.id === id) ?? null;
}

/**
 * The effect values the user asked for (preset, then custom theme, then
 * overrides), before readability clamping and render-mode adjustments.
 * Settings sliders show these values.
 */
export function requestedEffects(settings: AppearancePreferences): ThemeEffects {
  const custom = findCustom(settings);
  const presetId =
    custom?.base ??
    (settings.themeId in THEME_PRESETS
      ? (settings.themeId as keyof typeof THEME_PRESETS)
      : "liquid-dark");
  return mergeEffects(THEME_PRESETS[presetId].effects, custom?.effects, settings.effects);
}

/**
 * Merges preset, custom theme, user overrides and the render mode into the
 * final theme. Every numeric input is clamped to a safe range.
 */
export function resolveTheme(settings: AppearancePreferences): ResolvedTheme {
  const custom = findCustom(settings);
  const presetId =
    custom?.base ??
    (settings.themeId in THEME_PRESETS
      ? (settings.themeId as keyof typeof THEME_PRESETS)
      : "liquid-dark");
  const preset = THEME_PRESETS[presetId];

  const accentOverride = settings.accent ?? custom?.accent ?? null;
  const palette: ThemePalette = accentOverride
    ? {
        ...preset.palette,
        accent: accentOverride,
        accentStrong: deriveAccentStrong(accentOverride),
      }
    : { ...preset.palette };

  const wallpaper: WallpaperSpec = settings.wallpaper ??
    custom?.wallpaper ?? { kind: "preset", id: preset.wallpaper };
  const backdrops = wallpaperBackdrops(wallpaper);
  const minOpacity = minReadableOpacity(palette, backdrops);

  const requested = mergeEffects(preset.effects, custom?.effects, settings.effects);
  const effects: ThemeEffects = {
    surfaceOpacity: clamp(Math.max(requested.surfaceOpacity, minOpacity), 0.3, 1),
    blur: clamp(requested.blur, 0, 40),
    borderIntensity: clamp(requested.borderIntensity, 0, 1),
    shadowIntensity: clamp(requested.shadowIntensity, 0, 1),
    radius: clamp(requested.radius, 4, 32),
  };

  let wallpaperAnimated =
    settings.wallpaperAnimated &&
    wallpaper.kind === "preset" &&
    WALLPAPER_PRESETS[wallpaper.id].animatable;
  let windowAnimation = settings.windowAnimation;
  switch (settings.renderMode) {
    case "performance":
      effects.blur = 0;
      effects.surfaceOpacity = Math.max(effects.surfaceOpacity, 0.94);
      effects.shadowIntensity *= 0.5;
      wallpaperAnimated = false;
      windowAnimation = "none";
      break;
    case "balanced":
      effects.blur = Math.min(effects.blur, 16);
      break;
    case "premium":
      break;
  }

  return {
    id: custom ? `custom:${custom.id}` : presetId,
    scheme: palette.scheme,
    palette,
    ...accentColors(palette.accent, palette.accentStrong),
    effects,
    minReadableOpacity: minOpacity,
    renderMode: settings.renderMode,
    windowAnimation,
    wallpaper,
    wallpaperAnimated,
    fontScale: clamp(settings.fontScale, 0.85, 1.3),
    iconSize: settings.iconSize,
  };
}
