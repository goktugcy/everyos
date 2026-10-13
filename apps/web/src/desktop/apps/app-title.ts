import type { TFunction } from "i18next";
import { localized } from "./localized.ts";
import type { DesktopAppManifest } from "./types.ts";

export function appTitle(manifest: DesktopAppManifest, t: TFunction, locale: string): string {
  return manifest.installedApp
    ? localized(manifest.installedApp.name, locale)
    : t(manifest.titleKey);
}
