import type { AppCapability } from "./capabilities.ts";

export const MANIFEST_VERSION = 1;

/** The interface languages of EveryOS (kept equal to `SUPPORTED_LOCALES` by a test). */
export const APP_LOCALES = ["tr", "en", "de", "es", "fr", "it", "ja", "ko", "ru", "zh"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const APP_CATEGORIES = [
  "productivity",
  "developer",
  "system",
  "network",
  "media",
  "customization",
  "utilities",
  "education",
  "games",
  "other",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/** Same names as built-in widgets (`WIDGET_SIZES`, `WIDGET_PLACEMENTS` in @everyos/shared). */
export const APP_WIDGET_SIZES = ["compact", "small", "medium", "large"] as const;
export type AppWidgetSize = (typeof APP_WIDGET_SIZES)[number];
export const APP_WIDGET_PLACEMENTS = ["desktop", "sidebar", "menubar"] as const;
export type AppWidgetPlacement = (typeof APP_WIDGET_PLACEMENTS)[number];

export interface AppWindowSpec {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  /** `single` focuses the open window instead of opening another. */
  instances: "single" | "multiple";
}

export interface AppWidgetManifest {
  /** Unique within the app: `[a-z][a-z0-9-]*`. */
  id: string;
  /** English name; translations come from the app's locale files (`widgets.<id>.name`). */
  name: string;
  description: string;
  /** Document the widget frame loads, relative to the package root. */
  entry: string;
  sizes: AppWidgetSize[];
  defaultSize: AppWidgetSize;
  placements: AppWidgetPlacement[];
  /** A subset of the app's capabilities. */
  permissions: AppCapability[];
}

export interface AppLocales {
  /** Always `en` for official apps; the fallback for missing strings. */
  default: AppLocale;
  supported: AppLocale[];
  /** Folder with `<locale>.json` message files, relative to the package root. */
  path: string;
}

export interface AppPublisher {
  /** Reverse-DNS namespace that contains the app id. */
  id: string;
  name: string;
  url?: string | undefined;
}

export interface AppIntegration {
  /** Integration adapter of the hybrid app's backend (an existing EveryOS integration). */
  adapter: string;
}

export interface AppManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  id: string;
  /** English name; `app.name` in the locale files translates it. */
  name: string;
  version: string;
  description: string;
  /** HTML document the app window loads, relative to the package root. */
  entry: string;
  /** PNG, WebP or SVG icon, relative to the package root. */
  icon: string;
  category: AppCategory;
  permissions: AppCapability[];
  window: AppWindowSpec;
  widgets: AppWidgetManifest[];
  locales?: AppLocales | undefined;
  /** Oldest EveryOS release that runs the app. */
  minEveryOS?: string | undefined;
  /** SDK range the app was built against (e.g. `^1.0.0`). */
  sdk: string;
  publisher: AppPublisher;
  license?: string | undefined;
  homepage?: string | undefined;
  /** Where the source can be read, when the publisher shares it. */
  source?: string | undefined;
  integration?: AppIntegration | undefined;
}
