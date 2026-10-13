import { z } from "zod";
import {
  ALERT_KINDS,
  DATA_TOPICS,
  HOME_ASSISTANT_CONTROL_DOMAINS,
  INTEGRATION_ADAPTERS,
  INTEGRATION_AUDIENCES,
  INTEGRATION_TOPIC_PATTERN,
  MAX_WIDGET_INSTANCES,
  WIDGET_CUSTOM_LIMITS,
  WIDGET_PLACEMENTS,
  WIDGET_SCHEMA_VERSION,
  WIDGET_SIZES,
} from "../widgets.ts";
import { EVENT_TOPICS } from "../host.ts";
import { CAPABILITY_IDS } from "../system.ts";
import { PERMISSIONS } from "../permissions.ts";
import { HOME_ASSISTANT_SIMPLE_SERVICES } from "../home-assistant.ts";
import {
  HOME_ASSISTANT_CONTROL_FIELDS,
  type HomeAssistantControlId,
} from "../home-assistant-controls.ts";

const source = z.enum(["host", "simulated"]);
const n = z.number().nonnegative();

export const WidgetIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/)
  .max(64);

const ConfigValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(256)).max(32),
]);

export const WidgetInstanceSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  widgetId: WidgetIdSchema,
  widgetVersion: z.number().int().min(1).max(1000),
  placement: z.enum(WIDGET_PLACEMENTS),
  size: z.enum(WIDGET_SIZES),
  custom: z
    .strictObject({
      w: z.number().int().min(WIDGET_CUSTOM_LIMITS.minW).max(WIDGET_CUSTOM_LIMITS.maxW),
      h: z.number().int().min(WIDGET_CUSTOM_LIMITS.minH).max(WIDGET_CUSTOM_LIMITS.maxH),
    })
    .nullable(),
  position: z
    .strictObject({ col: z.number().int().min(0).max(200), row: z.number().int().min(0).max(200) })
    .nullable(),
  desktopId: z.string().max(64).nullable(),
  order: z.number().int().min(0).max(1000),
  opacity: z.number().min(0.3).max(1),
  locked: z.boolean(),
  config: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), ConfigValueSchema)
    .refine((config) => Object.keys(config).length <= 16, "too many config keys"),
});

export const WidgetPreferencesSchema = z.strictObject({
  version: z.literal(1),
  instances: z
    .array(WidgetInstanceSchema)
    .max(MAX_WIDGET_INSTANCES)
    .refine(
      (instances) => new Set(instances.map((i) => i.id)).size === instances.length,
      "duplicate widget ids",
    ),
  sidebar: z.strictObject({ open: z.boolean() }),
});

/* --------------------------- manifest validation --------------------------- */

const ConfigFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ key: z.string(), type: z.literal("boolean"), default: z.boolean() }),
  z.strictObject({
    key: z.string(),
    type: z.literal("select"),
    options: z.array(z.string()).min(1).max(20),
    default: z.string(),
  }),
  z.strictObject({
    key: z.string(),
    type: z.literal("number"),
    min: z.number(),
    max: z.number(),
    default: z.number(),
  }),
  z.strictObject({
    key: z.string(),
    type: z.literal("integration"),
    adapter: z.enum(INTEGRATION_ADAPTERS),
  }),
  z.strictObject({ key: z.string(), type: z.literal("dockerTarget") }),
  z.strictObject({ key: z.string(), type: z.literal("mount"), default: z.string() }),
  z.strictObject({
    key: z.string(),
    type: z.literal("entities"),
    control: z.boolean(),
    maxItems: z.number().int().max(32),
  }),
]);

const TopicTemplateSchema = z
  .string()
  .refine(
    (topic) =>
      (EVENT_TOPICS as readonly string[]).includes(topic) ||
      (DATA_TOPICS as readonly string[]).includes(topic) ||
      /^data\.integration\.\{integration\}\.[a-z]{2,24}$/.test(topic),
    "unknown topic",
  );

/** Versioned widget manifest (docs/contracts.md §3.1). Built-in manifests are validated against it. */
export const WidgetManifestSchema = z.strictObject({
  schemaVersion: z.literal(WIDGET_SCHEMA_VERSION),
  id: WidgetIdSchema,
  version: z.number().int().min(1),
  provider: z.union([z.enum(["system", "docker", "raspberryPi"]), z.enum(INTEGRATION_ADAPTERS)]),
  categories: z
    .array(z.enum(["system", "storage", "network", "docker", "raspberryPi", "apps"]))
    .min(1),
  supportedSizes: z.array(z.enum(WIDGET_SIZES)).min(1),
  defaultSize: z.enum(WIDGET_SIZES),
  placements: z.array(z.enum(WIDGET_PLACEMENTS)).min(1),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
  requiresCapability: z.enum(CAPABILITY_IDS).optional(),
  dataSources: z
    .array(
      z.strictObject({ topic: TopicTemplateSchema, minIntervalMs: z.number().int().min(1000) }),
    )
    .min(1),
  config: z.array(ConfigFieldSchema).max(12),
});

/* ------------------------------ event topics ------------------------------ */

export function isSubscribableTopic(topic: string): boolean {
  return (
    (EVENT_TOPICS as readonly string[]).includes(topic) ||
    (DATA_TOPICS as readonly string[]).includes(topic) ||
    INTEGRATION_TOPIC_PATTERN.test(topic)
  );
}

/* ------------------------------ integrations ------------------------------ */

const EntityIdSchema = z.string().regex(/^[a-z_]+\.[a-z0-9_]{1,100}$/);

export const IntegrationOptionsSchema = z.strictObject({
  entityScope: z.enum(["selected", "all"]).optional(),
  controlScope: z.enum(["selected", "all"]).optional(),
  entities: z.array(EntityIdSchema).max(64).optional(),
  controlEntities: z
    .array(EntityIdSchema)
    .max(32)
    .refine(
      (ids) => ids.every((id) => HOME_ASSISTANT_CONTROL_DOMAINS.includes(id.split(".")[0]!)),
      "control-domain",
    )
    .optional(),
  container: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    .optional(),
  user: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
    .optional(),
  database: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
    .optional(),
});

/** http(s) URL of a self-hosted app; credentials and fragments are not allowed in it. */
export const IntegrationBaseUrlSchema = z
  .string()
  .max(512)
  // http(s) only; no "user:pass@" credentials, fragments or whitespace.
  .regex(/^https?:\/\/[^/@\s#?]+(\/[^\s#]*)?$/, "base-url");

export const IntegrationCreateRequestSchema = z.strictObject({
  adapter: z.enum(INTEGRATION_ADAPTERS),
  name: z.string().trim().min(1).max(64),
  appId: z.string().uuid().nullable().optional(),
  baseUrl: IntegrationBaseUrlSchema.nullable().optional(),
  audience: z.enum(INTEGRATION_AUDIENCES).default("managers"),
  /** API key or token; stored encrypted, never returned. */
  secret: z.string().min(1).max(4096).optional(),
  /** Nextcloud: the account the app password belongs to (basic auth). */
  username: z.string().min(1).max(128).optional(),
  options: IntegrationOptionsSchema.default({}),
});

export const IntegrationUpdateRequestSchema = IntegrationCreateRequestSchema.omit({ adapter: true })
  .partial()
  .extend({
    clearSecret: z.boolean().optional(),
    // Creation defaults must not reset an existing connection during a partial edit.
    audience: z.enum(INTEGRATION_AUDIENCES).optional(),
    options: IntegrationOptionsSchema.optional(),
  });

export const IntegrationActionRequestSchema = z.discriminatedUnion("service", [
  z.strictObject({
    entityId: EntityIdSchema,
    service: z.literal("configure"),
    control: z.enum(
      Object.keys(HOME_ASSISTANT_CONTROL_FIELDS) as [
        HomeAssistantControlId,
        ...HomeAssistantControlId[],
      ],
    ),
    value: z.union([
      z.number().finite().min(-1e12).max(1e12),
      z.string().min(1).max(256),
      z.boolean(),
      z.tuple([z.number().finite().min(-1000).max(1000), z.number().finite().min(-1000).max(1000)]),
      z.tuple([
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
      ]),
    ]),
  }),
  z.strictObject({
    entityId: EntityIdSchema,
    service: z.enum(HOME_ASSISTANT_SIMPLE_SERVICES),
    confirm: z.literal(true).optional(),
  }),
  z.strictObject({
    entityId: EntityIdSchema,
    service: z.literal("set_temperature"),
    temperature: z.number().finite().min(-1000).max(1000),
  }),
  z.strictObject({
    entityId: EntityIdSchema,
    service: z.literal("set_hvac_mode"),
    hvacMode: z.string().min(1).max(64),
  }),
  z.strictObject({
    entityId: EntityIdSchema,
    service: z.literal("set_value"),
    value: z.number().finite().min(-1e12).max(1e12),
  }),
  z.strictObject({
    entityId: EntityIdSchema,
    service: z.literal("select_option"),
    option: z.string().min(1).max(256),
  }),
]);

/* ---------------------------- agent results ---------------------------- */

export const SocketSummarySchema = z.object({
  source,
  listening: z
    .array(
      z.object({
        protocol: z.enum(["tcp", "udp"]),
        address: z.string().max(64),
        port: z.number().int().min(0).max(65535),
        process: z.string().max(64).nullable(),
      }),
    )
    .max(2000),
  connections: z.object({ established: n, timeWait: n, other: n }),
});

export const AptUpdatesSchema = z.object({
  source,
  listsUpdatedAt: z.number().nullable(),
  total: n,
  security: n,
  packages: z
    .array(
      z.object({
        name: z.string().max(128),
        version: z.string().max(128),
        /** Installed version, when apt reports it. */
        currentVersion: z.string().max(128).nullable(),
        /** Suites offering the update, e.g. "noble-updates,noble-security". */
        suites: z.string().max(256),
        security: z.boolean(),
      }),
    )
    .max(500),
});

export const TimerSummarySchema = z.object({
  source,
  timers: z
    .array(
      z.object({
        unit: z.string().max(256),
        activates: z.string().max(256).nullable(),
        next: z.number().nullable(),
        last: z.number().nullable(),
      }),
    )
    .max(500),
});

export const PostgresStatsSchema = z.object({
  connections: n,
  maxConnections: n,
  databases: z.array(z.object({ name: z.string().max(128), sizeBytes: n })).max(256),
});

export type PostgresStats = z.infer<typeof PostgresStatsSchema>;

export const SystemAlertSchema = z.object({
  kind: z.enum(ALERT_KINDS),
  severity: z.enum(["warning", "critical"]),
  subject: z.string().max(256),
});
