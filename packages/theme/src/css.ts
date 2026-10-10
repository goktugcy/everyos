import type { IconSize } from "@otuken/shared";
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
      : WALLPAPER_PRESETS["otuken-dusk"].colors;
  const radius = Math.round(effects.radius);

  return {
    "--otk-accent": toTriplet(palette.accent),
    "--otk-accent-strong": toTriplet(palette.accentStrong),
    "--otk-accent-contrast": toTriplet(theme.accentContrast),
    "--otk-button-from": toTriplet(theme.button.from),
    "--otk-button-to": toTriplet(theme.button.to),
    "--otk-danger": toTriplet(palette.danger),
    "--otk-success": toTriplet(palette.success),
    "--otk-warning": toTriplet(palette.warning),
    "--otk-text": toTriplet(palette.text),
    "--otk-text-muted": toTriplet(palette.textMuted),
    "--otk-text-subtle": toTriplet(palette.textSubtle),
    "--otk-surface": toTriplet(palette.surface),
    "--otk-surface-opacity": effects.surfaceOpacity.toFixed(3),
    "--otk-surface-strong-opacity": Math.min(1, effects.surfaceOpacity + 0.18).toFixed(3),
    "--otk-border": toTriplet(palette.border),
    "--otk-border-opacity": (effects.borderIntensity * 0.3).toFixed(3),
    "--otk-highlight-opacity": dark ? "0.1" : "0.55",
    "--otk-shadow-opacity": effects.shadowIntensity.toFixed(3),
    "--otk-hover": dark ? "255 255 255" : "15 23 42",
    "--otk-inset": dark ? "0 0 0" : "255 255 255",
    "--otk-inset-opacity": dark ? "0.28" : "0.7",
    "--otk-blur": `${effects.blur}px`,
    "--otk-saturate": dark ? "165%" : "140%",
    "--otk-radius-lg": `${radius}px`,
    "--otk-radius-md": `${Math.max(6, Math.round(radius * 0.64))}px`,
    "--otk-radius-sm": `${Math.max(4, Math.round(radius * 0.45))}px`,
    "--otk-font-scale": theme.fontScale.toFixed(3),
    "--otk-icon-size": `${ICON_PIXELS[theme.iconSize]}px`,
    "--otk-wallpaper-base": wallpaperColors.base,
    "--otk-wallpaper-a": toTriplet(wallpaperColors.a),
    "--otk-wallpaper-b": toTriplet(wallpaperColors.b),
    "--otk-wallpaper-c": toTriplet(wallpaperColors.c),
  };
}
