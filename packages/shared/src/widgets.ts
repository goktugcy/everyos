/*
 * Zod-free widget platform constants and types (manifests, layouts,
 * integrations, data topics). Runtime schemas live in
 * "@otuken/shared/schemas" (schemas/widgets.ts); built-in manifests live in
 * "@otuken/widget-sdk".
 */

export const WIDGET_SCHEMA_VERSION = 1;

export const WIDGET_PLACEMENTS = ["desktop", "sidebar", "menubar"] as const;

export type WidgetPlacement = (typeof WIDGET_PLACEMENTS)[number];

/** `compact` is the single-line form used in the menu bar. */
export const WIDGET_SIZES = ["compact", "small", "medium", "large", "custom"] as const;

export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Desktop widgets snap to a grid of square cells. */
export const WIDGET_CELL_PX = 80;

/** Size presets in grid cells (columns × rows). */
export const WIDGET_SIZE_CELLS: Record<
  Exclude<WidgetSize, "compact" | "custom">,
  { w: number; h: number }
> = {
  small: { w: 2, h: 2 },
  medium: { w: 4, h: 2 },
  large: { w: 4, h: 4 },
};

export const WIDGET_CUSTOM_LIMITS = { minW: 2, minH: 1, maxW: 12, maxH: 10 } as const;

export const MAX_WIDGET_INSTANCES = 64;

export type WidgetConfigValue = string | number | boolean | string[];

/** One placed widget, stored in the user's `widgets` preference document. */
export interface WidgetInstance {
  id: string;
  /** Manifest id, e.g. "system.cpu" or "jellyfin.sessions". */
  widgetId: string;
  /** Manifest version the configuration was written for. */
  widgetVersion: number;
  placement: WidgetPlacement;
  size: WidgetSize;
  /** Cells when `size` is "custom". */
  custom: { w: number; h: number } | null;
  /** Desktop grid cell of the top-left corner. */
  position: { col: number; row: number } | null;
  /** Virtual desktop the widget lives on; null shows it on every desktop (pinned). */
  desktopId: string | null;
  /** Order within the sidebar or the menu bar. */
  order: number;
  /** 0.3–1 */
  opacity: number;
  /** Locked widgets cannot be moved or resized by accident. */
  locked: boolean;
  config: Record<string, WidgetConfigValue>;
}

export interface WidgetPreferences {
  version: 1;
  instances: WidgetInstance[];
  sidebar: { open: boolean };
}

/* ---------------------------- integrations ---------------------------- */

/**
 * Application adapters built into Otuken. Catalogs can only *declare* that
 * an app supports one of these; they can never ship widget code.
 */
export const INTEGRATION_ADAPTERS = [
  "jellyfin",
  "immich",
  "homeassistant",
  "uptimekuma",
  "nextcloud",
  "postgresql",
] as const;

export type IntegrationAdapter = (typeof INTEGRATION_ADAPTERS)[number];

/**
 * Who may see an integration's data: `managers` (apps:manage) by default,
 * because app data can be private (who is watching what, who is home);
 * `everyone` shares it with every user who can see apps.
 */
export const INTEGRATION_AUDIENCES = ["managers", "everyone"] as const;

export type IntegrationAudience = (typeof INTEGRATION_AUDIENCES)[number];

export interface IntegrationView {
  id: string;
  adapter: IntegrationAdapter;
  name: string;
  /** Installed app this integration belongs to (null for an external service). */
  appId: string | null;
  /** True when the linked app was uninstalled. */
  appMissing: boolean;
  baseUrl: string | null;
  audience: IntegrationAudience;
  /** Credentials are stored encrypted and never returned. */
  hasCredentials: boolean;
  options: IntegrationOptions;
  createdAt: number;
  updatedAt: number;
}

/** Adapter-specific, non-secret settings. */
export interface IntegrationOptions {
  /** Home Assistant: entities whose state may be shown. */
  entities?: string[] | undefined;
  /** Home Assistant: entities that may be toggled from quick-control widgets. */
  controlEntities?: string[] | undefined;
  /** PostgreSQL: container, role and database used for statistics. */
  container?: string | undefined;
  user?: string | undefined;
  database?: string | undefined;
}

/** Home Assistant domains that quick controls may switch. */
export const HOME_ASSISTANT_CONTROL_DOMAINS = [
  "switch",
  "light",
  "input_boolean",
  "fan",
  "cover",
  "script",
] as const;

/* -------------------------------- topics -------------------------------- */

/**
 * Shared server-side data providers. Many widgets (in many tabs, for many
 * users) reading the same topic cost one collector on the server.
 */
export const DATA_TOPICS = [
  "data.system",
  "data.storage",
  "data.network",
  "data.tailscale",
  "data.processes",
  "data.hardware",
  "data.services",
  "data.timers",
  "data.sockets",
  "data.apt",
  "data.docker",
  "data.alerts",
] as const;

export type DataTopic = (typeof DATA_TOPICS)[number];

/** `data.integration.<id>.<feed>`: one application feed. */
export const INTEGRATION_TOPIC_PATTERN = /^data\.integration\.([0-9a-f-]{36})\.([a-z]{2,24})$/;

export type TopicUnavailableReason =
  | "not-linux"
  | "not-detected"
  | "socket-missing"
  | "permission-denied"
  | "unsupported-hardware"
  | "tool-missing"
  | "app-offline"
  | "not-configured"
  | "auth-failed"
  | "app-removed";

/** One update of a data topic, delivered over the event stream as `event: data`. */
export type TopicMessage =
  | { topic: string; at: number; status: "ok"; data: unknown }
  | { topic: string; at: number; status: "unavailable"; reason: TopicUnavailableReason }
  | { topic: string; at: number; status: "error"; code: string };

/* --------------------------- derived data views --------------------------- */

export interface SocketSummary {
  source: "host" | "simulated";
  listening: Array<{
    protocol: "tcp" | "udp";
    address: string;
    port: number;
    process: string | null;
  }>;
  connections: { established: number; timeWait: number; other: number };
}

export interface AptUpdates {
  source: "host" | "simulated";
  /** Package lists are not refreshed by Otuken; this is when apt last refreshed them. */
  listsUpdatedAt: number | null;
  total: number;
  security: number;
  packages: Array<{
    name: string;
    version: string;
    currentVersion: string | null;
    suites: string;
    security: boolean;
  }>;
}

export interface TimerSummary {
  source: "host" | "simulated";
  timers: Array<{
    unit: string;
    activates: string | null;
    next: number | null;
    last: number | null;
  }>;
}

export const ALERT_KINDS = [
  "service-failed",
  "disk-full",
  "container-unhealthy",
  "throttling",
  "under-voltage",
  "nvme-unhealthy",
  "security-updates",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/** Current problems derived from real data; there is no stored alert history yet. */
export interface SystemAlert {
  kind: AlertKind;
  severity: "warning" | "critical";
  subject: string;
}

/** `data.alerts`: "simulated" when any contributing source is a development simulator. */
export interface AlertSummary {
  source: "host" | "simulated";
  alerts: SystemAlert[];
}
