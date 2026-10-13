import type { InstalledAppView } from "@everyos/shared";
import { create } from "zustand";

/** Preferences store only this identity, never a potentially stale port or launch URL. */
export type InstalledAppId = `everyos.installed.app-${string}`;

export function installedAppId(id: string): InstalledAppId {
  return `everyos.installed.app-${id}`;
}

export function installationId(id: string): string | null {
  return /^everyos\.installed\.app-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    id,
  )
    ? id.slice("everyos.installed.app-".length)
    : null;
}

export const useInstalledApps = create<{
  apps: readonly InstalledAppView[];
  loaded: boolean;
}>()(() => ({ apps: [], loaded: false }));

export function rememberInstalledApps(apps: InstalledAppView[]): void {
  useInstalledApps.setState({ apps, loaded: true });
}

export function clearInstalledApps(): void {
  useInstalledApps.setState({ apps: [], loaded: false });
}
