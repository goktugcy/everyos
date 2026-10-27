import type { TFunction } from "i18next";
import { i18next } from "../../app/i18n.ts";
import { useDesktopApps } from "../desktop-apps/store.ts";
import { localized } from "./localized.ts";
import type { DesktopAppManifest } from "./types.ts";

export function appTitle(
  manifest: DesktopAppManifest,
  t: TFunction,
  locale: string = i18next.language,
): string {
  if (manifest.desktopApp)
    return useDesktopApps.getState().names[manifest.desktopApp.appId] ?? manifest.desktopApp.name;
  return manifest.installedApp
    ? localized(manifest.installedApp.name, locale)
    : t(manifest.titleKey);
}
