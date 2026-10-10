import type { WidgetConfigField, WidgetManifest } from "./types.ts";

/*
 * Built-in widgets. Each one only *reads* shared data topics; rendering
 * lives in the web client and collection on the server (docs/contracts.md
 * §3.2). App widgets use built-in adapters only: catalogs can declare that
 * an app supports one, never ship code for it.
 */

const ALL = ["desktop", "sidebar", "menubar"] as WidgetManifest["placements"];
const PANEL = ["desktop", "sidebar"] as WidgetManifest["placements"];
const METRICS = [{ topic: "metrics" as const, minIntervalMs: 2_000 }];
const chart: WidgetConfigField = { key: "chart", type: "boolean", default: true };

function system(
  id: string,
  rest: Partial<WidgetManifest> & Pick<WidgetManifest, "supportedSizes" | "dataSources">,
): WidgetManifest {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    provider: "system",
    categories: ["system"],
    defaultSize: rest.supportedSizes.includes("small") ? "small" : rest.supportedSizes[0]!,
    placements: PANEL,
    permissions: ["system:read"],
    config: [],
    ...rest,
  };
}

function app(
  id: string,
  adapter: Extract<
    WidgetManifest["provider"],
    "jellyfin" | "immich" | "homeassistant" | "uptimekuma" | "nextcloud" | "postgresql"
  >,
  feed: string,
  intervalMs: number,
  rest: Partial<WidgetManifest> & Pick<WidgetManifest, "supportedSizes">,
): WidgetManifest {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    provider: adapter,
    categories: ["apps"],
    defaultSize: rest.supportedSizes.includes("small") ? "small" : rest.supportedSizes[0]!,
    placements: PANEL,
    permissions: ["apps:read"],
    dataSources: [{ topic: `data.integration.{integration}.${feed}`, minIntervalMs: intervalMs }],
    config: [{ key: "integration", type: "integration", adapter }],
    ...rest,
  };
}

export const BUILT_IN_WIDGETS: readonly WidgetManifest[] = [
  /* ------------------------------- system ------------------------------- */
  system("system.cpu", {
    supportedSizes: ["compact", "small", "medium", "large"],
    placements: ALL,
    dataSources: METRICS,
    config: [chart],
  }),
  system("system.cpuFrequency", {
    categories: ["system", "raspberryPi"],
    supportedSizes: ["compact", "small", "medium"],
    placements: ALL,
    dataSources: METRICS,
  }),
  system("system.temperature", {
    supportedSizes: ["compact", "small", "medium"],
    placements: ALL,
    requiresCapability: "thermal",
    dataSources: METRICS,
    config: [chart],
  }),
  system("system.memory", {
    supportedSizes: ["compact", "small", "medium", "large"],
    placements: ALL,
    dataSources: METRICS,
    config: [chart],
  }),
  system("system.swap", {
    supportedSizes: ["compact", "small"],
    placements: ALL,
    dataSources: METRICS,
  }),
  system("system.diskUsage", {
    categories: ["storage"],
    supportedSizes: ["compact", "small", "medium"],
    placements: ALL,
    dataSources: [{ topic: "data.storage", minIntervalMs: 30_000 }],
    config: [{ key: "mount", type: "mount", default: "/" }],
  }),
  system("system.diskIo", {
    categories: ["storage"],
    supportedSizes: ["small", "medium", "large"],
    dataSources: METRICS,
    config: [chart],
  }),
  system("system.mounts", {
    categories: ["storage"],
    supportedSizes: ["medium", "large"],
    dataSources: [{ topic: "data.storage", minIntervalMs: 30_000 }],
  }),
  system("system.network", {
    categories: ["network"],
    supportedSizes: ["compact", "small", "medium", "large"],
    placements: ALL,
    dataSources: METRICS,
    config: [chart],
  }),
  system("system.interfaces", {
    categories: ["network"],
    supportedSizes: ["medium", "large"],
    dataSources: [{ topic: "data.network", minIntervalMs: 30_000 }],
  }),
  system("system.ports", {
    categories: ["network"],
    supportedSizes: ["medium", "large"],
    requiresCapability: "procfs",
    dataSources: [{ topic: "data.sockets", minIntervalMs: 30_000 }],
  }),
  system("system.connections", {
    categories: ["network"],
    supportedSizes: ["compact", "small"],
    placements: ALL,
    requiresCapability: "procfs",
    dataSources: [{ topic: "data.sockets", minIntervalMs: 30_000 }],
  }),
  system("system.tailscale", {
    categories: ["network"],
    supportedSizes: ["compact", "small", "medium"],
    placements: ALL,
    dataSources: [{ topic: "data.tailscale", minIntervalMs: 30_000 }],
  }),
  system("system.uptime", {
    supportedSizes: ["compact", "small"],
    placements: ALL,
    dataSources: METRICS,
  }),
  system("system.load", {
    supportedSizes: ["compact", "small", "medium"],
    placements: ALL,
    dataSources: METRICS,
  }),
  system("system.processes", {
    supportedSizes: ["medium", "large"],
    dataSources: [{ topic: "data.processes", minIntervalMs: 5_000 }],
    config: [
      { key: "sort", type: "select", options: ["cpu", "memory"], default: "cpu" },
      { key: "count", type: "number", min: 3, max: 10, default: 5 },
    ],
  }),
  system("system.fans", { supportedSizes: ["small", "medium"], dataSources: METRICS }),
  system("system.sensors", { supportedSizes: ["small", "medium", "large"], dataSources: METRICS }),
  system("system.nvme", {
    categories: ["storage", "raspberryPi"],
    supportedSizes: ["small", "medium"],
    dataSources: [{ topic: "data.hardware", minIntervalMs: 60_000 }],
  }),
  system("system.apt", {
    supportedSizes: ["small", "medium"],
    dataSources: [{ topic: "data.apt", minIntervalMs: 30 * 60_000 }],
  }),
  system("system.alerts", {
    supportedSizes: ["small", "medium", "large"],
    dataSources: [{ topic: "data.alerts", minIntervalMs: 30_000 }],
  }),
  system("system.services", {
    supportedSizes: ["compact", "small", "medium"],
    placements: ALL,
    permissions: ["services:read"],
    requiresCapability: "systemd",
    dataSources: [{ topic: "data.services", minIntervalMs: 30_000 }],
  }),
  system("system.timers", {
    supportedSizes: ["medium", "large"],
    permissions: ["services:read"],
    requiresCapability: "systemd",
    dataSources: [{ topic: "data.timers", minIntervalMs: 60_000 }],
  }),

  /* ---------------------------- Raspberry Pi ---------------------------- */
  ...[
    system("raspberryPi.socTemperature", {
      supportedSizes: ["compact", "small", "medium"],
      placements: ALL,
      dataSources: METRICS,
      config: [chart],
    }),
    system("raspberryPi.throttling", {
      supportedSizes: ["small", "medium"],
      dataSources: [{ topic: "data.hardware", minIntervalMs: 60_000 }],
    }),
    system("raspberryPi.undervoltage", {
      supportedSizes: ["compact", "small"],
      placements: ALL,
      dataSources: [{ topic: "data.hardware", minIntervalMs: 60_000 }],
    }),
    system("raspberryPi.model", {
      supportedSizes: ["small", "medium"],
      dataSources: [{ topic: "data.system", minIntervalMs: 5 * 60_000 }],
    }),
  ].map((manifest): WidgetManifest => ({
    ...manifest,
    provider: "raspberryPi",
    categories: ["raspberryPi"],
    requiresCapability: "raspberryPi",
  })),

  /* -------------------------------- Docker -------------------------------- */
  ...[
    system("docker.summary", {
      supportedSizes: ["compact", "small", "medium"],
      placements: ALL,
      dataSources: [{ topic: "data.docker", minIntervalMs: 10_000 }],
    }),
    system("docker.resources", {
      supportedSizes: ["medium", "large"],
      dataSources: [
        { topic: "docker", minIntervalMs: 5_000 },
        { topic: "data.docker", minIntervalMs: 10_000 },
      ],
      config: [
        { key: "sort", type: "select", options: ["cpu", "memory"], default: "cpu" },
        { key: "count", type: "number", min: 3, max: 10, default: 5 },
      ],
    }),
    /** Generic widget for any container, Compose project or installed app. */
    system("docker.app", {
      supportedSizes: ["small", "medium"],
      dataSources: [
        { topic: "docker", minIntervalMs: 5_000 },
        { topic: "data.docker", minIntervalMs: 10_000 },
      ],
      config: [{ key: "target", type: "dockerTarget" }],
    }),
  ].map((manifest): WidgetManifest => ({
    ...manifest,
    provider: "docker",
    categories: ["docker"],
    permissions: ["docker:read"],
    requiresCapability: "docker",
  })),

  /* --------------------------------- apps --------------------------------- */
  app("jellyfin.status", "jellyfin", "status", 30_000, {
    supportedSizes: ["compact", "small"],
    placements: ALL,
  }),
  app("jellyfin.sessions", "jellyfin", "sessions", 15_000, { supportedSizes: ["medium", "large"] }),
  app("jellyfin.library", "jellyfin", "library", 5 * 60_000, {
    supportedSizes: ["small", "medium"],
  }),
  app("immich.status", "immich", "status", 30_000, {
    supportedSizes: ["compact", "small"],
    placements: ALL,
  }),
  app("immich.storage", "immich", "storage", 5 * 60_000, { supportedSizes: ["small", "medium"] }),
  app("immich.statistics", "immich", "statistics", 5 * 60_000, {
    supportedSizes: ["small", "medium"],
  }),
  app("homeassistant.entities", "homeassistant", "states", 15_000, {
    supportedSizes: ["small", "medium", "large"],
    config: [
      { key: "integration", type: "integration", adapter: "homeassistant" },
      { key: "entities", type: "entities", control: false, maxItems: 12 },
    ],
  }),
  app("homeassistant.automations", "homeassistant", "automations", 60_000, {
    supportedSizes: ["small", "medium"],
  }),
  /** Quick controls change devices, so they need apps:manage as well. */
  app("homeassistant.controls", "homeassistant", "states", 15_000, {
    supportedSizes: ["small", "medium"],
    permissions: ["apps:read", "apps:manage"],
    config: [
      { key: "integration", type: "integration", adapter: "homeassistant" },
      { key: "entities", type: "entities", control: true, maxItems: 8 },
    ],
  }),
  app("uptimekuma.monitors", "uptimekuma", "monitors", 30_000, {
    supportedSizes: ["medium", "large"],
  }),
  app("uptimekuma.incidents", "uptimekuma", "monitors", 30_000, {
    supportedSizes: ["compact", "small"],
    placements: ALL,
  }),
  app("nextcloud.status", "nextcloud", "status", 60_000, {
    supportedSizes: ["compact", "small"],
    placements: ALL,
  }),
  app("nextcloud.storage", "nextcloud", "serverinfo", 5 * 60_000, {
    supportedSizes: ["small", "medium"],
  }),
  app("postgresql.stats", "postgresql", "stats", 30_000, { supportedSizes: ["small", "medium"] }),
];

const BY_ID = new Map(BUILT_IN_WIDGETS.map((manifest) => [manifest.id, manifest]));

export function getWidget(id: string): WidgetManifest | undefined {
  return BY_ID.get(id);
}

/** i18n key segment for a widget id ("system.cpu" → "system_cpu"). */
export function widgetKey(id: string): string {
  return id.replaceAll(".", "_");
}
