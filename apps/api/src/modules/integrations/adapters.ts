import {
  HOME_ASSISTANT_SERVICES,
  type HomeAssistantAction,
  type HomeAssistantEntity,
  type HomeAssistantService,
  type HomeAssistantStates,
  type IntegrationAdapter,
  type IntegrationOptions,
  type PostgresStats,
} from "@everyos/shared";
import {
  IntegrationHttpError,
  joinUrl,
  requestJson,
  requestText,
  type HttpOptions,
} from "./http.ts";
import { homeAssistantRegistry } from "./home-assistant-registry.ts";

/*
 * Built-in application adapters. Each feed returns only the fields its
 * widgets display (data minimization): raw API responses never reach the
 * browser, and credentials stay in the API process.
 */

export class NotConfiguredError extends Error {
  constructor(message = "The integration is missing a URL or credentials") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export interface AdapterContext {
  baseUrl: string | null;
  secret: string | null;
  username: string | null;
  options: IntegrationOptions;
  signal: AbortSignal;
  /** Read-only agent access for adapters that need the host (PostgreSQL). */
  agent: {
    postgresStats(container: string, user: string, database: string): Promise<PostgresStats>;
    containerState(container: string): Promise<{ state: string; health: string } | null>;
  };
  /** Test hook for DNS. */
  resolve?: HttpOptions["resolve"];
}

export interface AdapterFeed {
  intervalMs: number;
  collect(context: AdapterContext): Promise<unknown>;
}

export interface AdapterDefinition {
  id: IntegrationAdapter;
  needsBaseUrl: boolean;
  credential: "none" | "required";
  /** Feed run by "Test connection". */
  testFeed: string;
  feeds: Record<string, AdapterFeed>;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, max = 256): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function base(context: AdapterContext): string {
  if (!context.baseUrl) throw new NotConfiguredError();
  return context.baseUrl;
}

function secret(context: AdapterContext): string {
  if (!context.secret) throw new NotConfiguredError();
  return context.secret;
}

function http(context: AdapterContext, headers: Record<string, string> = {}) {
  const options = (extra?: HttpOptions): HttpOptions => ({
    signal: context.signal,
    ...(context.resolve ? { resolve: context.resolve } : {}),
    ...extra,
    headers: { ...headers, ...(extra?.headers ?? {}) },
  });
  return {
    json: <T = unknown>(path: string, query?: Record<string, string>, extra?: HttpOptions) =>
      requestJson<T>(joinUrl(base(context), path, query), options(extra)),
    text: async (path: string, extra?: HttpOptions) =>
      (await requestText(joinUrl(base(context), path), options(extra))).text,
  };
}

/* ------------------------------- Jellyfin ------------------------------- */

const jellyfinAuth = (context: AdapterContext) => ({
  Authorization: `MediaBrowser Client="EveryOS", Device="EveryOS", DeviceId="everyos-widgets", Version="1", Token="${secret(context)}"`,
});

const jellyfin: AdapterDefinition = {
  id: "jellyfin",
  needsBaseUrl: true,
  credential: "required",
  testFeed: "sessions",
  feeds: {
    status: {
      intervalMs: 30_000,
      async collect(context) {
        const info = obj(await http(context).json("/System/Info/Public"));
        return { serverName: str(info.ServerName), version: str(info.Version, 32) };
      },
    },
    sessions: {
      intervalMs: 15_000,
      async collect(context) {
        const sessions = arr(
          await http(context, jellyfinAuth(context)).json("/Sessions", {
            activeWithinSeconds: "960",
          }),
        );
        const items = sessions.map(obj).map((session) => {
          const item = obj(session.NowPlayingItem);
          const play = obj(session.PlayState);
          const runtime = num(item.RunTimeTicks);
          const position = num(play.PositionTicks);
          return {
            user: str(session.UserName, 64),
            client: str(session.Client, 64),
            device: str(session.DeviceName, 64),
            title: str(item.Name, 128),
            series: str(item.SeriesName, 128),
            type: str(item.Type, 32),
            paused: play.IsPaused === true,
            progress: runtime && position !== null ? Math.min(1, position / runtime) : null,
          };
        });
        return {
          active: items.length,
          streaming: items.filter((s) => s.title !== null).length,
          sessions: items.filter((s) => s.title !== null).slice(0, 20),
        };
      },
    },
    library: {
      intervalMs: 5 * 60_000,
      async collect(context) {
        const counts = obj(await http(context, jellyfinAuth(context)).json("/Items/Counts"));
        return {
          movies: num(counts.MovieCount) ?? 0,
          series: num(counts.SeriesCount) ?? 0,
          episodes: num(counts.EpisodeCount) ?? 0,
          albums: num(counts.MusicAlbumCount) ?? 0,
          songs: num(counts.SongCount) ?? 0,
          books: num(counts.BookCount) ?? 0,
        };
      },
    },
  },
};

/* -------------------------------- Immich -------------------------------- */

const immichAuth = (context: AdapterContext) => ({ "x-api-key": secret(context) });

const immich: AdapterDefinition = {
  id: "immich",
  needsBaseUrl: true,
  credential: "required",
  testFeed: "storage",
  feeds: {
    status: {
      intervalMs: 30_000,
      async collect(context) {
        const client = http(context, immichAuth(context));
        const ping = obj(await client.json("/api/server/ping"));
        const version = obj(await client.json("/api/server/version"));
        const parts = [version.major, version.minor, version.patch].map(num);
        return {
          online: ping.res === "pong",
          version: parts.every((p) => p !== null) ? parts.join(".") : null,
        };
      },
    },
    storage: {
      intervalMs: 5 * 60_000,
      async collect(context) {
        const storage = obj(await http(context, immichAuth(context)).json("/api/server/storage"));
        return {
          totalBytes: num(storage.diskSizeRaw) ?? 0,
          usedBytes: num(storage.diskUseRaw) ?? 0,
          availableBytes: num(storage.diskAvailableRaw) ?? 0,
        };
      },
    },
    statistics: {
      intervalMs: 5 * 60_000,
      async collect(context) {
        // Server statistics need an API key of an administrator.
        const stats = obj(await http(context, immichAuth(context)).json("/api/server/statistics"));
        return {
          photos: num(stats.photos) ?? 0,
          videos: num(stats.videos) ?? 0,
          usageBytes: num(stats.usage) ?? 0,
        };
      },
    },
  },
};

/* ----------------------------- Home Assistant ----------------------------- */

const haAuth = (context: AdapterContext) => ({ Authorization: `Bearer ${secret(context)}` });

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]{1,100}$/;
const ENTITY_FEATURES: Readonly<Record<string, Partial<Record<HomeAssistantService, number>>>> = {
  fan: { turn_on: 32, turn_off: 16, toggle: 48 },
  media_player: { turn_on: 128, turn_off: 256, media_play: 16384, media_pause: 1 },
  vacuum: { start: 8192, pause: 4, stop: 8, return_to_base: 16 },
};

function canControl(context: AdapterContext, entityId: string): boolean {
  return (
    Object.hasOwn(HOME_ASSISTANT_SERVICES, entityId.split(".")[0]!) &&
    (context.options.controlScope === "all" ||
      (context.options.controlEntities ?? []).includes(entityId))
  );
}

function canView(context: AdapterContext, entityId: string): boolean {
  return (
    context.options.entityScope === "all" ||
    (context.options.entities ?? []).includes(entityId) ||
    canControl(context, entityId)
  );
}

function serviceMap(raw: unknown): Map<string, Set<string>> {
  return new Map(
    arr(raw)
      .map(obj)
      .map((entry) => [
        str(entry.domain, 64) ?? "",
        new Set(
          Array.isArray(entry.services)
            ? entry.services.filter((v): v is string => typeof v === "string")
            : Object.keys(obj(entry.services)),
        ),
      ]),
  );
}

function toEntity(raw: Json, services: Map<string, Set<string>>): HomeAssistantEntity {
  const attributes = obj(raw.attributes);
  const entityId = str(raw.entity_id, 128) ?? "";
  const domain = entityId.split(".")[0]!;
  const changed = Date.parse(str(raw.last_changed, 64) ?? "");
  const features = num(attributes.supported_features) ?? 0;
  const min = num(domain === "climate" ? attributes.min_temp : attributes.min);
  const max = num(domain === "climate" ? attributes.max_temp : attributes.max);
  const options = arr(domain === "climate" ? attributes.hvac_modes : attributes.options)
    .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 256)
    .slice(0, 256);
  const actions = (
    Object.hasOwn(HOME_ASSISTANT_SERVICES, domain) ? (HOME_ASSISTANT_SERVICES[domain] ?? []) : []
  ).filter((service) => {
    if (!services.get(domain)?.has(service)) return false;
    const flag = Object.hasOwn(ENTITY_FEATURES, domain)
      ? ENTITY_FEATURES[domain]?.[service]
      : undefined;
    if (
      flag !== undefined &&
      num(attributes.supported_features) !== null &&
      (features & flag) !== flag
    )
      return false;
    if (domain === "cover") {
      const flag = { open_cover: 1, close_cover: 2, stop_cover: 8 }[
        service as "open_cover" | "close_cover" | "stop_cover"
      ];
      return (features & flag) !== 0;
    }
    if (service === "set_temperature")
      return (features & 1) !== 0 && min !== null && max !== null && min <= max;
    if (service === "set_value") return min !== null && max !== null && min <= max;
    if (service === "select_option" || service === "set_hvac_mode") return options.length > 0;
    if (domain === "climate" && service === "turn_on") return (features & 256) !== 0;
    if (domain === "climate" && service === "turn_off") return (features & 128) !== 0;
    return true;
  });
  return {
    entityId,
    name: str(attributes.friendly_name, 128),
    state: str(raw.state, 64) ?? "unknown",
    unit: str(
      domain === "climate" ? attributes.temperature_unit : attributes.unit_of_measurement,
      16,
    ),
    deviceClass: str(attributes.device_class, 32),
    device: null,
    area: null,
    icon: str(attributes.icon, 128),
    category: null,
    lastChanged: Number.isFinite(changed) ? changed : null,
    actions: [...actions],
    currentTemperature: num(attributes.current_temperature),
    targetTemperature: num(attributes.temperature),
    min,
    max,
    step: num(domain === "climate" ? attributes.target_temp_step : attributes.step),
    options,
  };
}

export async function collectHomeAssistantStates(
  context: AdapterContext,
): Promise<HomeAssistantStates> {
  const client = http(context, haAuth(context));
  const [raw, services, registry] = await Promise.all([
    client.json("/api/states", undefined, { maxBytes: 16 * 1024 * 1024, timeoutMs: 20_000 }),
    client.json("/api/services", undefined, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000 }),
    homeAssistantRegistry(context),
  ]);
  if (!Array.isArray(raw) || !Array.isArray(services))
    throw new IntegrationHttpError("invalid", "Invalid Home Assistant response");
  if (raw.length > 10_000)
    throw new IntegrationHttpError("too-large", "Too many Home Assistant entities");
  const registered = serviceMap(services);
  const entities = raw
    .map(obj)
    .filter(
      (state) =>
        ENTITY_ID.test(str(state.entity_id, 128) ?? "") &&
        canView(context, str(state.entity_id, 128)!),
    )
    .map((state) => {
      const entity = toEntity(state, registered);
      const metadata = registry.entities.get(entity.entityId);
      if (metadata) {
        entity.device = metadata.device;
        entity.area = metadata.area;
        entity.icon ??= metadata.icon;
        entity.category = metadata.category;
      }
      if (!canControl(context, entity.entityId)) entity.actions = [];
      return entity;
    })
    .sort((a, b) => (a.name ?? a.entityId).localeCompare(b.name ?? b.entityId));
  return {
    source: "host",
    registry: registry.status,
    entities,
    controllable: entities.filter((e) => e.actions.length > 0).map((e) => e.entityId),
  };
}

const homeassistant: AdapterDefinition = {
  id: "homeassistant",
  needsBaseUrl: true,
  credential: "required",
  testFeed: "states",
  feeds: {
    states: {
      intervalMs: 15_000,
      async collect(context) {
        return collectHomeAssistantStates(context);
      },
    },
    automations: {
      intervalMs: 60_000,
      async collect(context) {
        const automations = arr(await http(context, haAuth(context)).json("/api/states"))
          .map(obj)
          .filter(
            (state) =>
              (str(state.entity_id, 128) ?? "").startsWith("automation.") &&
              canView(context, str(state.entity_id, 128)!),
          );
        const items = automations.map((raw) => {
          const entity = toEntity(raw, new Map());
          const triggered = Date.parse(str(obj(raw.attributes).last_triggered, 64) ?? "");
          return {
            entityId: entity.entityId,
            name: entity.name,
            state: entity.state,
            lastTriggered: Number.isFinite(triggered) ? triggered : null,
          };
        });
        return {
          total: items.length,
          on: items.filter((i) => i.state === "on").length,
          off: items.filter((i) => i.state === "off").length,
          unavailable: items.filter((i) => i.state === "unavailable").length,
          items: items.slice(0, 50),
        };
      },
    },
  },
};

/** Fresh state and service capabilities are rechecked before every fixed device action. */
export async function homeAssistantTarget(
  context: AdapterContext,
  entityId: string,
): Promise<HomeAssistantEntity> {
  const client = http(context, haAuth(context));
  const [raw, services] = await Promise.all([
    client.json(`/api/states/${entityId}`, undefined, { maxBytes: 256 * 1024 }),
    client.json("/api/services", undefined, { maxBytes: 4 * 1024 * 1024 }),
  ]);
  if (obj(raw).entity_id !== entityId || !Array.isArray(services))
    throw new IntegrationHttpError("invalid", "Invalid Home Assistant response");
  return toEntity(obj(raw), serviceMap(services));
}

export async function callHomeAssistant(
  context: AdapterContext,
  action: HomeAssistantAction,
  service: HomeAssistantService,
): Promise<void> {
  const domain = action.entityId.split(".")[0]!;
  const params =
    action.service === "set_temperature"
      ? { temperature: action.temperature }
      : action.service === "set_hvac_mode"
        ? { hvac_mode: action.hvacMode }
        : action.service === "set_value"
          ? { value: action.value }
          : action.service === "select_option"
            ? { option: action.option }
            : {};
  await http(context, haAuth(context)).json(`/api/services/${domain}/${service}`, undefined, {
    method: "POST",
    body: { entity_id: action.entityId, ...params },
  });
}

/* ------------------------------ Uptime Kuma ------------------------------ */

const KUMA_STATUS: Record<string, "down" | "up" | "pending" | "maintenance"> = {
  "0": "down",
  "1": "up",
  "2": "pending",
  "3": "maintenance",
};

/** Prometheus text from `/metrics` → monitor status (names and types only, never URLs). */
export function parseKumaMetrics(text: string) {
  const monitors = new Map<
    string,
    {
      name: string;
      type: string | null;
      status: "down" | "up" | "pending" | "maintenance";
      responseMs: number | null;
    }
  >();
  for (const line of text.split("\n")) {
    const match = /^(monitor_status|monitor_response_time)\{([^}]*)\}\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const labels = Object.fromEntries(
      [...match[2]!.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    const name = (labels.monitor_name ?? "").slice(0, 128);
    if (!name) continue;
    const entry = monitors.get(name) ?? {
      name,
      type: labels.monitor_type?.slice(0, 32) ?? null,
      status: "pending" as const,
      responseMs: null,
    };
    if (match[1] === "monitor_status") entry.status = KUMA_STATUS[match[3]!] ?? "pending";
    else entry.responseMs = Number.isFinite(Number(match[3])) ? Math.round(Number(match[3])) : null;
    monitors.set(name, entry);
  }
  const list = [...monitors.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
  return {
    up: list.filter((m) => m.status === "up").length,
    down: list.filter((m) => m.status === "down").length,
    pending: list.filter((m) => m.status === "pending").length,
    maintenance: list.filter((m) => m.status === "maintenance").length,
    monitors: list,
  };
}

const uptimekuma: AdapterDefinition = {
  id: "uptimekuma",
  needsBaseUrl: true,
  credential: "required",
  testFeed: "monitors",
  feeds: {
    monitors: {
      intervalMs: 30_000,
      async collect(context) {
        // API keys are sent as the basic-auth password with an empty user name.
        const auth = Buffer.from(`:${secret(context)}`).toString("base64");
        return parseKumaMetrics(
          await http(context, { Authorization: `Basic ${auth}` }).text("/metrics"),
        );
      },
    },
  },
};

/* -------------------------------- Nextcloud -------------------------------- */

const nextcloud: AdapterDefinition = {
  id: "nextcloud",
  needsBaseUrl: true,
  credential: "required",
  testFeed: "serverinfo",
  feeds: {
    status: {
      intervalMs: 60_000,
      async collect(context) {
        const status = obj(await http(context).json("/status.php"));
        return {
          installed: status.installed === true,
          maintenance: status.maintenance === true,
          version: str(status.versionstring, 32),
        };
      },
    },
    serverinfo: {
      intervalMs: 5 * 60_000,
      async collect(context) {
        // A serverinfo token (NC-Token) or an administrator's app password (basic auth).
        const headers: Record<string, string> = { "OCS-APIRequest": "true" };
        if (context.username)
          headers.Authorization = `Basic ${Buffer.from(`${context.username}:${secret(context)}`).toString("base64")}`;
        else headers["NC-Token"] = secret(context);
        const data = obj(
          obj(
            obj(
              await http(context, headers).json("/ocs/v2.php/apps/serverinfo/api/v1/info", {
                format: "json",
                skipApps: "true",
                skipUpdate: "true",
              }),
            ).ocs,
          ).data,
        );
        const server = obj(data.nextcloud);
        const storage = obj(server.storage);
        const active = obj(data.activeUsers);
        return {
          version: str(obj(server.system).version, 32),
          users: num(storage.num_users) ?? 0,
          files: num(storage.num_files) ?? 0,
          freeBytes: num(obj(server.system).freespace),
          activeUsers24h: num(active.last24hours),
        };
      },
    },
  },
};

/* ------------------------------- PostgreSQL ------------------------------- */

const postgresql: AdapterDefinition = {
  id: "postgresql",
  needsBaseUrl: false,
  credential: "none",
  testFeed: "stats",
  feeds: {
    stats: {
      intervalMs: 30_000,
      async collect(context) {
        const { container, user, database } = context.options;
        if (!container || !user || !database)
          throw new NotConfiguredError("Container, role and database are required");
        const state = await context.agent.containerState(container);
        if (!state) throw new NotConfiguredError("Container not found");
        if (state.state !== "running") return { container: state, stats: null };
        return {
          container: state,
          stats: await context.agent.postgresStats(container, user, database),
        };
      },
    },
  },
};

export const ADAPTERS: Record<IntegrationAdapter, AdapterDefinition> = {
  jellyfin,
  immich,
  homeassistant,
  uptimekuma,
  nextcloud,
  postgresql,
};
