import { z } from "zod";
import {
  EVENT_TOPICS,
  INTERNET_STATES,
  METRIC_RANGES,
  NETWORK_INTERFACE_KINDS,
  SERVICE_ACTIONS,
  THROTTLE_FLAGS,
  UNIT_NAME_PATTERN,
} from "../host.ts";
import { CAPABILITY_REASONS, DATA_SOURCES } from "../system.ts";
import { DATA_TOPICS, INTEGRATION_TOPIC_PATTERN } from "../widgets.ts";

const n = z.number().nonnegative();
const name = z.string().max(128);
const source = z.enum(DATA_SOURCES);
const availability = z.object({
  available: z.boolean(),
  reason: z.enum(CAPABILITY_REASONS).optional(),
});

/* ------------------------------ metrics ------------------------------ */

/** Cumulative CPU time counters (clock ticks on Linux). Rates are computed by the API. */
export const CpuTimesSchema = z.object({
  user: n,
  nice: n,
  system: n,
  idle: n,
  iowait: n,
  irq: n,
  softirq: n,
  steal: n,
});

export type CpuTimes = z.infer<typeof CpuTimesSchema>;

/** One raw reading of fast-changing host counters (cheap /proc and /sys reads). */
export const MetricsSampleSchema = z.object({
  source,
  at: n,
  uptimeSeconds: n,
  cpu: z.object({ total: CpuTimesSchema, cores: z.array(CpuTimesSchema).max(512) }).nullable(),
  memory: z
    .object({
      totalBytes: n,
      availableBytes: n,
      freeBytes: n,
      buffersBytes: n,
      cachedBytes: n,
      swapTotalBytes: n,
      swapFreeBytes: n,
    })
    .nullable(),
  load: z.tuple([n, n, n]).nullable(),
  network: z
    .array(
      z.object({
        name,
        rxBytes: n,
        txBytes: n,
        rxPackets: n,
        txPackets: n,
        rxErrors: n,
        txErrors: n,
        /** Backed by hardware (not a bridge, veth, tunnel…); only these count towards host totals. */
        physical: z.boolean(),
      }),
    )
    .max(256)
    .nullable(),
  disks: z
    .array(z.object({ name, readBytes: n, writeBytes: n, readOps: n, writeOps: n, busyMs: n }))
    .max(256)
    .nullable(),
  thermal: z
    .array(z.object({ zone: name, type: name, celsius: z.number() }))
    .max(64)
    .nullable(),
  cpuFrequencyMHz: z.array(n).max(512).nullable(),
  fans: z
    .array(z.object({ name, rpm: n }))
    .max(32)
    .nullable(),
});

export type MetricsSample = z.infer<typeof MetricsSampleSchema>;

export const StorageUsageSchema = z.object({
  source,
  mounts: z
    .array(
      z.object({
        device: z.string().max(256),
        mountpoint: z.string().max(1024),
        fsType: name,
        readOnly: z.boolean(),
        totalBytes: n,
        usedBytes: n,
        availableBytes: n,
        inodesTotal: n,
        inodesFree: n,
      }),
    )
    .max(256),
});

export type StorageUsage = z.infer<typeof StorageUsageSchema>;

export const HardwareStatusSchema = z.object({
  source,
  throttling: z.object({
    status: availability,
    flags: z.record(z.enum(THROTTLE_FLAGS), z.boolean()).nullable(),
    raw: z.string().max(32).nullable(),
  }),
  nvme: z.object({
    status: availability,
    devices: z
      .array(
        z.object({
          device: z.string().max(64),
          model: z.string().max(128).nullable(),
          temperatureC: z.number().nullable(),
          percentageUsed: z.number().nullable(),
          availableSparePercent: z.number().nullable(),
          powerOnHours: z.number().nullable(),
          mediaErrors: z.number().nullable(),
          criticalWarning: z.number().nullable(),
          healthy: z.boolean().nullable(),
        }),
      )
      .max(16),
  }),
});

export type HardwareStatus = z.infer<typeof HardwareStatusSchema>;

/* ------------------------------ network ------------------------------ */

export const NetworkStatusSchema = z.object({
  source,
  interfaces: z
    .array(
      z.object({
        name,
        kind: z.enum(NETWORK_INTERFACE_KINDS),
        up: z.boolean(),
        mac: z.string().max(32).nullable(),
        mtu: z.number().nullable(),
        speedMbps: z.number().nullable(),
        addresses: z
          .array(
            z.object({
              family: z.enum(["ipv4", "ipv6"]),
              address: z.string().max(64),
              prefix: z.number(),
            }),
          )
          .max(64),
      }),
    )
    .max(256),
  gateways: z
    .array(
      z.object({ interface: name, address: z.string().max(64), family: z.enum(["ipv4", "ipv6"]) }),
    )
    .max(32),
  dns: z.array(z.string().max(64)).max(16),
  internet: z.object({
    state: z.enum(INTERNET_STATES),
    checkedAt: z.number().nullable(),
    latencyMs: z.number().nullable(),
  }),
});

export type NetworkStatus = z.infer<typeof NetworkStatusSchema>;

export const TailscaleStatusSchema = z.object({
  status: availability,
  backendState: z.string().max(64).nullable(),
  version: z.string().max(64).nullable(),
  hostName: z.string().max(256).nullable(),
  dnsName: z.string().max(256).nullable(),
  tailnet: z.string().max(256).nullable(),
  ips: z.array(z.string().max(64)).max(8),
  online: z.boolean().nullable(),
  exitNode: z.object({
    active: z.boolean(),
    name: z.string().max(256).nullable(),
    online: z.boolean().nullable(),
  }),
  peers: z.object({ total: n, online: n }),
  health: z.array(z.string().max(512)).max(32),
});

export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>;

const tsText = (max = 256) => z.string().max(max).nullable();

/** Turns EveryOS's own Tailscale Serve handler (HTTPS 443 → the API on loopback) on or off. */
export const TailscaleServeSchema = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
});
export const TailscaleServeResultSchema = z.strictObject({
  /** `https://<node>.<tailnet>.ts.net` while on. */
  url: z.string().max(300).nullable(),
});

/** This node in more detail: key expiry, relay, routes, preferences and Serve/Funnel handlers. */
export const TailscaleDetailsSchema = z.object({
  status: availability,
  self: z.object({
    os: tsText(64),
    /** Home DERP relay region (e.g. "fra"). */
    relay: tsText(64),
    /** Node key expiry (ms); null when expiry is disabled for this node or unknown. */
    keyExpiry: n.nullable(),
    keyExpired: z.boolean(),
    /** Offered and approved as an exit node for other devices. */
    exitNodeOption: z.boolean(),
    /** Subnet routes this node serves for the tailnet. */
    routes: z.array(z.string().max(64)).max(64),
    tags: z.array(z.string().max(128)).max(32),
    magicDNS: z.boolean().nullable(),
    magicDNSSuffix: tsText(),
  }),
  prefs: z.object({
    available: z.boolean(),
    ssh: z.boolean().nullable(),
    shieldsUp: z.boolean().nullable(),
    acceptRoutes: z.boolean().nullable(),
    acceptDNS: z.boolean().nullable(),
    advertisedRoutes: z.array(z.string().max(64)).max(64),
    advertisesExitNode: z.boolean().nullable(),
    exitNodeAllowLAN: z.boolean().nullable(),
  }),
  serve: z.object({
    available: z.boolean(),
    handlers: z
      .array(
        z.object({
          /** MagicDNS name the handler answers on ("" for raw TCP forwarding). */
          host: z.string().max(256),
          port: z.number().int().min(1).max(65535),
          path: z.string().max(256),
          kind: z.enum(["proxy", "files", "text", "tcp"]),
          /** Proxy or TCP target; files and text handlers have none. */
          target: tsText(512),
          /** Reachable from the public internet through Tailscale Funnel. */
          funnel: z.boolean(),
        }),
      )
      .max(64),
  }),
});

export type TailscaleDetails = z.infer<typeof TailscaleDetailsSchema>;

export const TailscalePeerSchema = z.object({
  hostName: tsText(),
  dnsName: tsText(),
  os: tsText(64),
  ips: z.array(z.string().max(64)).max(4),
  online: z.boolean().nullable(),
  /** Traffic flowed recently. */
  active: z.boolean(),
  lastSeen: n.nullable(),
  /** This node currently uses the peer as its exit node. */
  exitNode: z.boolean(),
  exitNodeOption: z.boolean(),
  /** How traffic currently flows: a direct path, a DERP relay, or no recent traffic. */
  connection: z.enum(["direct", "relay", "idle"]),
  relay: tsText(64),
  rxBytes: n,
  txBytes: n,
  keyExpiry: n.nullable(),
  tags: z.array(z.string().max(128)).max(32),
});

export const TailscalePeersSchema = z.object({
  status: availability,
  peers: z.array(TailscalePeerSchema).max(500),
});

export type TailscalePeer = z.infer<typeof TailscalePeerSchema>;
export type TailscalePeers = z.infer<typeof TailscalePeersSchema>;

/* ----------------------------- processes ----------------------------- */

export const ProcessInfoSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().max(64),
  user: z.string().max(64).nullable(),
  state: z.string().max(4),
  cpuPercent: n,
  memoryBytes: n,
  threads: n,
  command: z.string().max(512),
  startedAt: z.number().nullable(),
});

export const ProcessListSchema = z.object({
  source,
  sampledAt: n,
  total: n,
  processes: z.array(ProcessInfoSchema).max(500),
});

export type ProcessList = z.infer<typeof ProcessListSchema>;

export const ProcessQuerySchema = z.strictObject({
  sort: z.enum(["cpu", "memory"]).default("cpu"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/* ------------------------------ systemd ------------------------------ */

export const UnitNameSchema = z
  .string()
  .regex(UNIT_NAME_PATTERN, "unit-name")
  .refine((v) => !v.includes(".."));

export const ProcessInspectRequestSchema = z.strictObject({
  pid: z.coerce.number().int().positive().max(2_147_483_647),
  startedAt: z.coerce.number().nonnegative().optional(),
});
export const ProcessInspectQuerySchema = ProcessInspectRequestSchema.omit({ pid: true });
export const ProcessPidParamsSchema = ProcessInspectRequestSchema.pick({ pid: true });
export const ProcessDetailSchema = ProcessInfoSchema.extend({
  source,
  sampledAt: n,
  parentPid: z.number().int().nonnegative().nullable(),
  virtualMemoryBytes: n.nullable(),
  threads: n.nullable(),
  executable: z.string().max(4096).nullable(),
  workingDirectory: z.string().max(4096).nullable(),
  serviceUnit: UnitNameSchema.nullable(),
  containerId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type ProcessDetail = z.infer<typeof ProcessDetailSchema>;

export const ServiceUnitSchema = z.object({
  name: z.string().max(256),
  description: z.string().max(512),
  load: name,
  active: name,
  sub: name,
  unitFileState: name.nullable(),
  /** Protected units cannot be stopped, disabled or restarted from EveryOS. */
  protected: z.boolean(),
});

export type ServiceUnit = z.infer<typeof ServiceUnitSchema>;

export const ServiceListSchema = z.object({ source, units: z.array(ServiceUnitSchema).max(4000) });

export type ServiceList = z.infer<typeof ServiceListSchema>;

export const ServiceDetailSchema = ServiceUnitSchema.extend({
  source,
  mainPid: z.number().nullable(),
  activeSince: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  cpuNanoseconds: z.number().nullable(),
  tasks: z.number().nullable(),
  restarts: z.number().nullable(),
  fragmentPath: z.string().max(1024).nullable(),
  restartPolicy: z.string().max(64).nullable(),
  type: z.string().max(64).nullable(),
});

export type ServiceDetail = z.infer<typeof ServiceDetailSchema>;

export const ServiceActionRequestSchema = z.strictObject({ action: z.enum(SERVICE_ACTIONS) });

/* ------------------------------- logs ------------------------------- */

export const LogEntrySchema = z.object({
  cursor: z.string().max(512),
  ts: n,
  priority: z.number().int().min(0).max(7),
  unit: z.string().max(256).nullable(),
  identifier: z.string().max(128).nullable(),
  pid: z.number().nullable(),
  hostname: z.string().max(256).nullable(),
  message: z.string().max(16_384),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogPageSchema = z.object({
  source,
  entries: z.array(LogEntrySchema).max(1000),
  hasMore: z.boolean(),
});

export type LogPage = z.infer<typeof LogPageSchema>;

/** Journal filters shared by the HTTP API and the agent. */
export const LogFilterSchema = z.strictObject({
  unit: UnitNameSchema.optional(),
  /** Show this priority and everything more severe (0–7). */
  priority: z.coerce.number().int().min(0).max(7).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  grep: z.string().trim().min(1).max(200).optional(),
});

export const LogQuerySchema = LogFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** Continue towards older entries from this cursor (exclusive). */
  before: z.string().max(512).optional(),
});

export type LogQuery = z.infer<typeof LogQuerySchema>;

/* ------------------------------ history ------------------------------ */

export const MetricsHistoryQuerySchema = z.strictObject({
  range: z.enum(METRIC_RANGES).default("15m"),
});

export const EventStreamQuerySchema = z.strictObject({
  topics: z
    .string()
    .max(6000)
    .transform((value) => [...new Set(value.split(",").filter(Boolean))])
    .pipe(
      z
        .array(
          z
            .string()
            .max(128)
            .refine(
              (topic) =>
                (EVENT_TOPICS as readonly string[]).includes(topic) ||
                (DATA_TOPICS as readonly string[]).includes(topic) ||
                INTEGRATION_TOPIC_PATTERN.test(topic),
              "unknown-topic",
            ),
        )
        .min(1)
        .max(64),
    ),
});
