import type { IconSize } from "@everyos/shared";
import { toTriplet } from "./color.ts";
import type { ResolvedTheme } from "./resolve.ts";
import { WALLPAPER_PRESETS } from "./wallpapers.ts";

export const ICON_PIXELS: Record<IconSize, number> = { small: 40, medium: 52, large: 64 };

/**
 * Maps a resolved theme to the CSS custom properties consumed by the
 * stylesheet. Colors are "r g b" triplets so components can vary alpha.
 */
export function themeCssVariables(theme: ResolvedTheme): Record<string, string> {
  const { palette, effects } = theme;
  const dark = theme.scheme === "dark";
  const wallpaperColors =
    theme.wallpaper.kind === "preset"
      ? WALLPAPER_PRESETS[theme.wallpaper.id].colors
      : WALLPAPER_PRESETS["everyos-dusk"].colors;
  const radius = Math.round(effects.radius);

  return {
    "--everyos-accent": toTriplet(palette.accent),
    "--everyos-accent-strong": toTriplet(palette.accentStrong),
    "--everyos-accent-contrast": toTriplet(theme.accentContrast),
    "--everyos-button-from": toTriplet(theme.button.from),
    "--everyos-button-to": toTriplet(theme.button.to),
    "--everyos-danger": toTriplet(palette.danger),
    "--everyos-success": toTriplet(palette.success),
    "--everyos-warning": toTriplet(palette.warning),
    "--everyos-text": toTriplet(palette.text),
    "--everyos-text-muted": toTriplet(palette.textMuted),
    "--everyos-text-subtle": toTriplet(palette.textSubtle),
    "--everyos-surface": toTriplet(palette.surface),
    "--everyos-surface-opacity": effects.surfaceOpacity.toFixed(3),
    "--everyos-surface-strong-opacity": Math.min(1, effects.surfaceOpacity + 0.18).toFixed(3),
    "--everyos-border": toTriplet(palette.border),
    "--everyos-border-opacity": (effects.borderIntensity * 0.3).toFixed(3),
    "--everyos-highlight-opacity": dark ? "0.1" : "0.55",
    "--everyos-shadow-opacity": effects.shadowIntensity.toFixed(3),
    "--everyos-hover": dark ? "255 255 255" : "15 23 42",
    "--everyos-inset": dark ? "0 0 0" : "255 255 255",
    "--everyos-inset-opacity": dark ? "0.28" : "0.7",
    "--everyos-blur": `${effects.blur}px`,
    "--everyos-saturate": dark ? "165%" : "140%",
    "--everyos-radius-lg": `${radius}px`,
    "--everyos-radius-md": `${Math.max(6, Math.round(radius * 0.64))}px`,
    "--everyos-radius-sm": `${Math.max(4, Math.round(radius * 0.45))}px`,
    "--everyos-font-scale": theme.fontScale.toFixed(3),
    "--everyos-icon-size": `${ICON_PIXELS[theme.iconSize]}px`,
    "--everyos-wallpaper-base": wallpaperColors.base,
    "--everyos-wallpaper-a": toTriplet(wallpaperColors.a),
    "--everyos-wallpaper-b": toTriplet(wallpaperColors.b),
    "--everyos-wallpaper-c": toTriplet(wallpaperColors.c),
  };
}
