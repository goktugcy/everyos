import type { ThemeSnapshot } from "@everyos/app-sdk/protocol";
import { themeCssVariables, type ResolvedTheme } from "@everyos/theme";

/** Desktop-only tokens (wallpaper, menu bar geometry) that mean nothing inside an app. */
const PRIVATE = /^--everyos-(wallpaper|menubar|caption|icon-size)/;

/** What an app needs to look like the desktop around it. */
export function themeSnapshot(theme: ResolvedTheme): ThemeSnapshot {
  const tokens = Object.fromEntries(
    Object.entries(themeCssVariables(theme)).filter(([name]) => !PRIVATE.test(name)),
  );
  const prefersReducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    scheme: theme.scheme,
    tokens,
    accent: theme.palette.accent,
    fontFamily: getComputedStyle(document.body).fontFamily,
    reducedMotion: prefersReducedMotion || theme.windowAnimation === "none",
    reducedTransparency: theme.renderMode === "performance",
    density: theme.iconSize === "small" ? "compact" : "comfortable",
  };
}
