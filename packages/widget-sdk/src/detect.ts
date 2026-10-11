import type { IntegrationAdapter } from "@everyos/shared";
import { BUILT_IN_WIDGETS } from "./manifests.ts";
import type { WidgetManifest } from "./types.ts";

/**
 * Repository path of an image reference without registry, tag or digest:
 * "lscr.io/linuxserver/jellyfin:10.11" → "linuxserver/jellyfin",
 * "postgres:17-alpine" → "postgres".
 */
export function repositoryOf(image: string): string {
  let reference = image.trim().toLowerCase().split("@")[0]!;
  const parts = reference.split("/");
  if (
    parts.length > 1 &&
    (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost")
  ) {
    parts.shift();
  }
  reference = parts.join("/");
  const colon = reference.lastIndexOf(":");
  if (colon > reference.lastIndexOf("/")) reference = reference.slice(0, colon);
  return reference.replace(/^library\//, "");
}

/** Images known to run an app EveryOS has a built-in adapter for. */
const RULES: ReadonlyArray<[IntegrationAdapter, RegExp]> = [
  ["jellyfin", /^(jellyfin\/jellyfin|linuxserver\/jellyfin|hotio\/jellyfin)$/],
  ["immich", /^(immich-app\/immich-server|altran1502\/immich-server)$/],
  [
    "homeassistant",
    /^(homeassistant\/home-assistant|home-assistant\/home-assistant|linuxserver\/homeassistant)$/,
  ],
  ["uptimekuma", /^louislam\/uptime-kuma$/],
  ["nextcloud", /^(nextcloud|linuxserver\/nextcloud)$/],
  [
    "postgresql",
    /^(postgres|bitnami\/postgresql|pgvector\/pgvector|tensorchord\/pgvecto-rs|immich-app\/postgres|postgis\/postgis)$/,
  ],
];

/** Built-in adapters that match an app's images (derived from images, never from catalog claims). */
export function detectAdapters(images: readonly string[]): IntegrationAdapter[] {
  const repositories = images.map(repositoryOf);
  return RULES.filter(([, pattern]) =>
    repositories.some((repository) => pattern.test(repository)),
  ).map(([adapter]) => adapter);
}

export function widgetsForAdapter(adapter: IntegrationAdapter): WidgetManifest[] {
  return BUILT_IN_WIDGETS.filter((manifest) => manifest.provider === adapter);
}
