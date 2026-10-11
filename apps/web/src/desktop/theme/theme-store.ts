import type { AppearancePreferences } from "@everyos/shared";
import {
  DEFAULT_APPEARANCE,
  resolveTheme,
  themeCssVariables,
  type ResolvedTheme,
} from "@everyos/theme";
import { create } from "zustand";

const CACHE_KEY = "everyos.appearance";

interface ThemeState {
  appearance: AppearancePreferences;
  theme: ResolvedTheme;
}

function readCache(): AppearancePreferences | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY) ?? localStorage.getItem("otuken.appearance");
    if (!raw) return null;
    const parsed = JSON.parse(raw, (key: string, value: unknown) =>
      key === "id" && value === "otuken-dusk" ? "everyos-dusk" : value,
    ) as AppearancePreferences;
    // Uploaded images need a session; sign-in screens fall back to the theme default.
    return parsed.version === 1
      ? { ...parsed, wallpaper: parsed.wallpaper?.kind === "image" ? null : parsed.wallpaper }
      : null;
  } catch {
    return null;
  }
}

function writeCache(appearance: AppearancePreferences): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(appearance));
  } catch {
    // Storage unavailable: the theme still applies for this page.
  }
}

/** Writes the resolved theme to <html> as CSS custom properties and data attributes. */
function applyToDocument(theme: ResolvedTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeCssVariables(theme)))
    root.style.setProperty(name, value);
  root.dataset.scheme = theme.scheme;
  root.dataset.render = theme.renderMode;
  root.dataset.windowAnimation = theme.windowAnimation;
  root.dataset.wallpaperAnimated = String(theme.wallpaperAnimated);
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme.scheme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme.scheme === "dark" ? "#0b1020" : "#e9eef4");
}

const initialAppearance = readCache() ?? DEFAULT_APPEARANCE;
const initialTheme = resolveTheme(initialAppearance);
applyToDocument(initialTheme);

export const useThemeStore = create<ThemeState>()(() => ({
  appearance: initialAppearance,
  theme: initialTheme,
}));

export function applyAppearance(appearance: AppearancePreferences): void {
  const theme = resolveTheme(appearance);
  applyToDocument(theme);
  writeCache(appearance);
  useThemeStore.setState({ appearance, theme });
}
