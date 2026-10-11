import { z } from "zod";
import {
  COMPOSE_ACTIONS,
  COMPOSE_PROJECT_PATTERN,
  CONTAINER_ACTIONS,
  CONTAINER_ID_PATTERN,
  CONTAINER_RISKS,
  CONTAINER_STATES,
  DOCKER_MANAGERS,
  DOCKER_OWNERSHIP,
  HEALTH_STATES,
  IMAGE_ID_PATTERN,
  NETWORK_ID_PATTERN,
  VOLUME_NAME_PATTERN,
} from "../docker.ts";
import { CAPABILITY_REASONS, DATA_SOURCES } from "../system.ts";

const n = z.number().nonnegative();
const text = (max: number) => z.string().max(max);
const source = z.enum(DATA_SOURCES);

export const ContainerIdSchema = z.string().regex(CONTAINER_ID_PATTERN, "container-id");
export const ImageIdSchema = z.string().regex(IMAGE_ID_PATTERN, "image-id");
export const NetworkIdSchema = z.string().regex(NETWORK_ID_PATTERN, "network-id");
export const VolumeNameSchema = z.string().regex(VOLUME_NAME_PATTERN, "volume-name");
export const ComposeProjectNameSchema = z.string().regex(COMPOSE_PROJECT_PATTERN, "project-name");

/** Absolute, normalized path of a Compose file (validated again on the host by the agent). */
export const ComposeFilePathSchema = z
  .string()
  .max(1024)
  .regex(/^\/[^\0]*\.ya?ml$/, "compose-file")
  .refine(
    (value) => !value.split("/").some((part) => part === ".." || part === "."),
    "compose-file",
  );

/* ------------------------------- status ------------------------------- */

export const DockerStatusSchema = z.object({
  source,
  status: z.object({ available: z.boolean(), reason: z.enum(CAPABILITY_REASONS).optional() }),
  version: text(64).nullable(),
  apiVersion: text(16).nullable(),
  os: text(64).nullable(),
  arch: text(32).nullable(),
  storageDriver: text(64).nullable(),
  containers: z.object({ total: n, running: n, paused: n, stopped: n }),
  images: n,
  compose: z.object({ available: z.boolean(), version: text(64).nullable() }),
});

export type DockerStatus = z.infer<typeof DockerStatusSchema>;

/* ----------------------------- containers ----------------------------- */

const PortSchema = z.object({
  privatePort: z.number().int().min(0).max(65535),
  publicPort: z.number().int().min(0).max(65535).nullable(),
  type: z.enum(["tcp", "udp", "sctp"]),
  ip: text(64).nullable(),
});

export const ContainerSummarySchema = z.object({
  id: ContainerIdSchema,
  name: text(256),
  image: text(512),
  imageId: text(128),
  state: z.enum(CONTAINER_STATES),
  status: text(256),
  health: z.enum(HEALTH_STATES),
  createdAt: n,
  ports: z.array(PortSchema).max(256),
  project: text(128).nullable(),
  service: text(128).nullable(),
  networks: z.array(text(256)).max(64),
  managerHint: z.enum(DOCKER_MANAGERS).nullable(),
  /** Configured in agent.yaml: may only be started from EveryOS. */
  protected: z.boolean(),
});

export type ContainerSummary = z.infer<typeof ContainerSummarySchema>;

export const ContainerListSchema = z.object({
  source,
  containers: z.array(ContainerSummarySchema).max(2000),
});

export type ContainerList = z.infer<typeof ContainerListSchema>;

export const ContainerDetailSchema = ContainerSummarySchema.extend({
  source,
  command: text(2048).nullable(),
  entrypoint: text(2048).nullable(),
  workingDir: text(1024).nullable(),
  user: text(128).nullable(),
  /** Environment variable names only; values may hold secrets and never leave the agent. */
  envKeys: z.array(text(256)).max(512),
  labels: z.record(text(256), text(1024)),
  mounts: z
    .array(
      z.object({
        type: text(32),
        source: text(1024).nullable(),
        destination: text(1024),
        readOnly: z.boolean(),
      }),
    )
    .max(256),
  networkDetails: z
    .array(
      z.object({ name: text(256), ipAddress: text(64).nullable(), gateway: text(64).nullable() }),
    )
    .max(64),
  restartPolicy: text(64).nullable(),
  restartCount: n,
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  exitCode: z.number().nullable(),
  oomKilled: z.boolean(),
  pid: z.number().nullable(),
  healthLog: z
    .array(
      z.object({ at: z.number().nullable(), exitCode: z.number().nullable(), output: text(1024) }),
    )
    .max(10),
  limits: z.object({ memoryBytes: z.number().nullable(), cpus: z.number().nullable() }),
  risks: z.array(z.enum(CONTAINER_RISKS)).max(CONTAINER_RISKS.length),
});

export type ContainerDetail = z.infer<typeof ContainerDetailSchema>;

/** Raw cumulative counters from one `stats?one-shot=true` call; rates are derived by the API. */
export const ContainerStatsSampleSchema = z.object({
  id: ContainerIdSchema,
  at: n,
  cpuTotalNs: n,
  systemCpuNs: n.nullable(),
  onlineCpus: n.nullable(),
  memoryBytes: n,
  memoryLimitBytes: n.nullable(),
  netRxBytes: n.nullable(),
  netTxBytes: n.nullable(),
  blockReadBytes: n.nullable(),
  blockWriteBytes: n.nullable(),
  pids: n.nullable(),
});

export type ContainerStatsSample = z.infer<typeof ContainerStatsSampleSchema>;

export const ContainerStatsListSchema = z.object({
  source,
  samples: z.array(ContainerStatsSampleSchema).max(500),
});

export type ContainerStatsList = z.infer<typeof ContainerStatsListSchema>;

export const ContainerLogLineSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  ts: z.number().nullable(),
  line: text(16_384),
});

export type ContainerLogLine = z.infer<typeof ContainerLogLineSchema>;

export const ContainerActionRequestSchema = z.strictObject({ action: z.enum(CONTAINER_ACTIONS) });

export const ContainerLogsQuerySchema = z.strictObject({
  tail: z.coerce.number().int().min(0).max(5000).default(200),
  follow: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Only lines at or after this time (epoch ms). */
  since: z.coerce.number().int().nonnegative().optional(),
});

/* ----------------------- images, volumes, networks ----------------------- */

export const ImageSummarySchema = z.object({
  id: text(128),
  tags: z.array(text(512)).max(256),
  createdAt: n,
  sizeBytes: n,
  dangling: z.boolean(),
  usedBy: z.array(text(256)).max(2000),
});

export type ImageSummary = z.infer<typeof ImageSummarySchema>;

export const ImageListSchema = z.object({ source, images: z.array(ImageSummarySchema).max(5000) });

export type ImageList = z.infer<typeof ImageListSchema>;

export const VolumeSummarySchema = z.object({
  name: text(256),
  driver: text(64),
  mountpoint: text(1024).nullable(),
  createdAt: z.number().nullable(),
  project: text(128).nullable(),
  sizeBytes: z.number().nullable(),
  usedBy: z.array(text(256)).max(2000),
});

export type VolumeSummary = z.infer<typeof VolumeSummarySchema>;

export const VolumeListSchema = z.object({
  source,
  volumes: z.array(VolumeSummarySchema).max(5000),
});

export type VolumeList = z.infer<typeof VolumeListSchema>;

export const NetworkSummarySchema = z.object({
  id: text(128),
  name: text(256),
  driver: text(64),
  scope: text(32),
  internal: z.boolean(),
  subnets: z.array(text(64)).max(16),
  project: text(128).nullable(),
  builtIn: z.boolean(),
  usedBy: z.array(text(256)).max(2000),
});

export type NetworkSummary = z.infer<typeof NetworkSummarySchema>;

export const NetworkListSchema = z.object({
  source,
  networks: z.array(NetworkSummarySchema).max(1000),
});

export type NetworkList = z.infer<typeof NetworkListSchema>;

/** Typing the volume name back is required before a volume (and its data) is deleted. */
export const VolumeRemoveRequestSchema = z.strictObject({ confirmName: VolumeNameSchema });

/* ------------------------------- compose ------------------------------- */

export const ComposeProjectSchema = z.object({
  name: ComposeProjectNameSchema,
  workingDir: text(1024).nullable(),
  configFiles: z.array(text(1024)).max(16),
  services: z.array(text(128)).max(256),
  containers: z.object({ total: n, running: n }),
  managerHint: z.enum(DOCKER_MANAGERS).nullable(),
});

export type ComposeProject = z.infer<typeof ComposeProjectSchema>;

export const ComposeProjectListSchema = z.object({
  source,
  projects: z.array(ComposeProjectSchema).max(1000),
});

export type ComposeProjectList = z.infer<typeof ComposeProjectListSchema>;

/** Result of checking a project's Compose files on the host before import or an action. */
export const ComposeFileCheckSchema = z.object({
  project: ComposeProjectNameSchema,
  workingDir: text(1024).nullable(),
  files: z
    .array(
      z.object({
        path: text(1024),
        ok: z.boolean(),
        reason: z.enum([
          "ok",
          "missing",
          "not-regular",
          "too-large",
          "not-compose",
          "invalid-path",
          "unreadable",
        ]),
      }),
    )
    .max(16),
});

export type ComposeFileCheck = z.infer<typeof ComposeFileCheckSchema>;

export const ComposeActionRequestSchema = z.strictObject({ action: z.enum(COMPOSE_ACTIONS) });

export const ComposeActionResultSchema = z.object({
  ok: z.boolean(),
  /** Last lines of Compose's output, sanitized. */
  output: text(16_384),
});

export type ComposeActionResult = z.infer<typeof ComposeActionResultSchema>;

/** Imported project as stored and returned by the API. */
export const ComposeProjectViewSchema = ComposeProjectSchema.extend({
  ownership: z.enum(DOCKER_OWNERSHIP),
  importedAt: z.number().nullable(),
  importedBy: text(64).nullable(),
});

export type ComposeProjectView = z.infer<typeof ComposeProjectViewSchema>;

/* -------------------------------- events -------------------------------- */

export const DockerEventSchema = z.object({
  type: z.enum(["container", "image", "volume", "network"]),
  action: text(64),
  id: text(256),
  name: text(256).nullable(),
  at: n,
});

export type DockerEvent = z.infer<typeof DockerEventSchema>;

/** Container as returned by the API: summary plus EveryOS's ownership view. */
export type DockerContainerView = ContainerSummary & {
  ownership: (typeof DOCKER_OWNERSHIP)[number];
};
