import { AGENT_FILE_OPERATIONS } from "./file-operations.ts";
import type { Permission } from "@everyos/shared";
import {
  AiDiscoverySchema,
  NativeAgentIdSchema,
  NativeAgentSnapshotSchema,
  LinuxAccountSchema,
  LinuxAccountStatusSchema,
  LinuxBindingSchema,
  LinuxBindSchema,
  LinuxUnbindSchema,
  LinuxUnlockSchema,
  LinuxLockSchema,
  AppInstallDefaultsSchema,
  ReleaseInstallSchema,
  ReleaseJobSchema,
  SelfUpdateStatusSchema,
  ComposeActionRequestSchema,
  ComposeActionResultSchema,
  ComposeFileCheckSchema,
  ComposeFilePathSchema,
  ComposeProjectListSchema,
  ComposeProjectNameSchema,
  ContainerActionRequestSchema,
  ContainerDetailSchema,
  ContainerIdSchema,
  ContainerListSchema,
  ContainerLogLineSchema,
  ContainerStatsListSchema,
  DockerEventSchema,
  DockerStatusSchema,
  HardwareStatusSchema,
  PowerStatusSchema,
  ImageIdSchema,
  ImageListSchema,
  NetworkIdSchema,
  NetworkListSchema,
  VolumeListSchema,
  VolumeNameSchema,
  LogEntrySchema,
  LogFilterSchema,
  LogPageSchema,
  LogQuerySchema,
  MetricsSampleSchema,
  NetworkStatusSchema,
  ProcessListSchema,
  ProcessQuerySchema,
  ServiceActionRequestSchema,
  ServiceDetailSchema,
  ServiceListSchema,
  StorageUsageSchema,
  SystemInfoSchema,
  TailscaleStatusSchema,
  TailscaleDetailsSchema,
  TailscalePeersSchema,
  UnitNameSchema,
  AptUpdatesSchema,
  PostgresStatsSchema,
  SocketSummarySchema,
  TimerSummarySchema,
  ManagedAppRunSchema,
  ManagedAppResultSchema,
  ManagedAppInspectSchema,
  ManagedAppInspectionSchema,
  TerminalCloseSchema,
  TerminalEventSchema,
  TerminalInputSchema,
  TerminalOpenSchema,
  TerminalResizeSchema,
  TerminalStatusSchema,
  AptRefreshResultSchema,
  AptUpgradeEventSchema,
  AptUpgradeParamsSchema,
  PackageInfoSchema,
  PackageNameSchema,
  AppDataExportBeginResultSchema,
  AppDataExportBeginSchema,
  AppDataExportReadResultSchema,
  AppDataExportReadSchema,
  AppDataTransferAbortSchema,
  AppDataImportBeginSchema,
  AppDataImportChunkSchema,
  AppDataImportCommitSchema,
  AppDataImportResultSchema,
} from "@everyos/shared/schemas";
import { z } from "zod";

interface ContractBase<P extends z.ZodType> {
  params: P;
  /** Permission the requesting user must hold; null means any authenticated actor. */
  permission: Permission | null;
  /** Whether internal API jobs (actor kind "system") may call this operation. */
  allowSystemActor: boolean;
  /** Mutating operations are always written to the agent audit log. */
  mutating: boolean;
}

/** A request answered by exactly one result. */
export interface UnaryContract<
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> extends ContractBase<P> {
  kind: "unary";
  result: R;
  /** Hard upper bound enforced by the agent; the client uses the same value. */
  timeoutMs: number;
}

/**
 * A request answered by a sequence of events, terminated by a normal
 * response (`result: null`) or an error. Streams are always read-only.
 */
export interface StreamContract<
  P extends z.ZodType = z.ZodType,
  E extends z.ZodType = z.ZodType,
> extends ContractBase<P> {
  kind: "stream";
  event: E;
  /** Mutating streams (e.g. a terminal session) are written to the agent audit log. */
  mutating: boolean;
  /** The agent ends the stream with a `timeout` error after this long; clients reconnect. */
  maxDurationMs: number;
}

/**
 * Contract for one agent operation. The agent only executes operations that
 * appear in this registry; there is deliberately no generic "run command"
 * operation.
 */
export type OperationContract = UnaryContract | StreamContract;

function unary<P extends z.ZodType, R extends z.ZodType>(
  contract: Omit<UnaryContract<P, R>, "kind">,
): UnaryContract<P, R> {
  return { kind: "unary", ...contract };
}

function stream<P extends z.ZodType, E extends z.ZodType>(
  contract: Omit<StreamContract<P, E>, "kind">,
): StreamContract<P, E> {
  return { kind: "stream", ...contract };
}

const NoParams = z.strictObject({});

export const AGENT_OPERATIONS = {
  ...AGENT_FILE_OPERATIONS,
  "ai.discover": unary({
    params: NoParams,
    result: z.strictObject({
      source: z.enum(["host", "simulated"]),
      discoveries: z.array(AiDiscoverySchema).max(40),
    }),
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 30_000,
  }),
  "ai.snapshot": unary({
    params: z.strictObject({
      id: NativeAgentIdSchema,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      includeHistory: z.boolean(),
    }),
    result: NativeAgentSnapshotSchema,
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 30_000,
  }),
  "identity.accounts": unary({
    params: NoParams,
    result: z.array(LinuxAccountSchema),
    permission: "users:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "identity.bindings": unary({
    params: NoParams,
    result: z.array(LinuxBindingSchema),
    permission: "users:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "identity.bind": unary({
    params: LinuxBindSchema,
    result: LinuxBindingSchema,
    permission: "users:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 20_000,
  }),
  "identity.unbind": unary({
    params: LinuxUnbindSchema,
    result: z.null(),
    permission: "users:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 20_000,
  }),
  "identity.status": unary({
    params: NoParams,
    result: LinuxAccountStatusSchema,
    permission: null,
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "identity.unlock": unary({
    params: LinuxUnlockSchema,
    result: LinuxAccountStatusSchema,
    permission: null,
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 20_000,
  }),
  "identity.lock": unary({
    params: LinuxLockSchema,
    result: z.null(),
    permission: null,
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 20_000,
  }),

  "release.status": unary({
    params: NoParams,
    result: SelfUpdateStatusSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "release.check": unary({
    params: NoParams,
    result: SelfUpdateStatusSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 120_000,
  }),
  "release.install": unary({
    params: ReleaseInstallSchema,
    result: ReleaseJobSchema,
    permission: "system:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 120_000,
  }),
  "apps.inspect": unary({
    params: ManagedAppInspectSchema,
    result: ManagedAppInspectionSchema,
    permission: "apps:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "apps.defaults": unary({
    params: NoParams,
    result: AppInstallDefaultsSchema,
    permission: "apps:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "apps.run": unary({
    params: ManagedAppRunSchema,
    result: ManagedAppResultSchema,
    permission: "apps:manage",
    allowSystemActor: false,
    mutating: true,
    // Image pulls (up to 45 min for multi-GB model servers) plus two Compose runs.
    timeoutMs: 75 * 60_000,
  }),
  "agent.ping": unary({
    params: NoParams,
    result: z.strictObject({
      pong: z.literal(true),
      agentVersion: z.string(),
      uptimeSeconds: z.number().nonnegative(),
      mode: z.enum(["production", "development"]),
    }),
    permission: null,
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 2_000,
  }),
  "system.info": unary({
    params: NoParams,
    result: SystemInfoSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 5_000,
  }),
  "metrics.sample": unary({
    params: NoParams,
    result: MetricsSampleSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 5_000,
  }),
  "storage.usage": unary({
    params: NoParams,
    result: StorageUsageSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "power.status": unary({
    params: NoParams,
    result: PowerStatusSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 5_000,
  }),
  "hardware.status": unary({
    params: NoParams,
    result: HardwareStatusSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 25_000,
  }),
  "network.status": unary({
    params: NoParams,
    result: NetworkStatusSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "tailscale.status": unary({
    params: NoParams,
    result: TailscaleStatusSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 8_000,
  }),
  /** This node's key expiry, relay, routes, preferences and Serve/Funnel handlers. */
  "tailscale.details": unary({
    params: NoParams,
    result: TailscaleDetailsSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 12_000,
  }),
  /** The tailnet's other devices: names, addresses and connection paths. */
  "tailscale.peers": unary({
    params: NoParams,
    result: TailscalePeersSchema,
    permission: "system:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 8_000,
  }),
  "processes.list": unary({
    params: ProcessQuerySchema,
    result: ProcessListSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "services.list": unary({
    params: NoParams,
    result: ServiceListSchema,
    permission: "services:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "services.get": unary({
    params: z.strictObject({ unit: UnitNameSchema }),
    result: ServiceDetailSchema,
    permission: "services:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 12_000,
  }),
  "services.control": unary({
    params: ServiceActionRequestSchema.extend({ unit: UnitNameSchema }),
    result: z.strictObject({ accepted: z.literal(true) }),
    permission: "services:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 35_000,
  }),
  "logs.query": unary({
    params: LogQuerySchema,
    result: LogPageSchema,
    permission: "logs:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "network.sockets": unary({
    params: NoParams,
    result: SocketSummarySchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 20_000,
  }),
  /** Pending package updates from the local lists; never runs `apt update`. */
  "apt.updates": unary({
    params: NoParams,
    result: AptUpdatesSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 70_000,
  }),
  "services.timers": unary({
    params: NoParams,
    result: TimerSummarySchema,
    permission: "services:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 12_000,
  }),
  /** Fixed read-only statistics query inside a PostgreSQL container (widget integrations). */
  "apps.postgres.stats": unary({
    params: z.strictObject({
      container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
      user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
      database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
    }),
    result: PostgresStatsSchema,
    permission: "apps:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "logs.follow": stream({
    params: LogFilterSchema.omit({ since: true, until: true }),
    event: LogEntrySchema,
    permission: "logs:read",
    allowSystemActor: false,
    mutating: false,
    maxDurationMs: 60 * 60_000,
  }),
  "docker.status": unary({
    params: NoParams,
    result: DockerStatusSchema,
    permission: "docker:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 15_000,
  }),
  "docker.containers.list": unary({
    params: NoParams,
    result: ContainerListSchema,
    permission: "docker:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 15_000,
  }),
  "docker.containers.get": unary({
    params: z.strictObject({ id: ContainerIdSchema }),
    result: ContainerDetailSchema,
    permission: "docker:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 15_000,
  }),
  /** Raw counters of every running container (one `stats?one-shot=true` call each). */
  "docker.containers.stats": unary({
    params: NoParams,
    result: ContainerStatsListSchema,
    permission: "docker:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "docker.containers.control": unary({
    params: ContainerActionRequestSchema.extend({ id: ContainerIdSchema }),
    result: z.strictObject({ accepted: z.literal(true) }),
    permission: "docker:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 75_000,
  }),
  "docker.containers.logs": stream({
    params: z.strictObject({
      id: ContainerIdSchema,
      tail: z.number().int().min(0).max(5000),
      follow: z.boolean(),
      since: z.number().int().nonnegative().optional(),
    }),
    event: ContainerLogLineSchema,
    permission: "logs:read",
    allowSystemActor: false,
    mutating: false,
    maxDurationMs: 60 * 60_000,
  }),
  "docker.images.list": unary({
    params: NoParams,
    result: ImageListSchema,
    permission: "docker:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "docker.images.remove": unary({
    params: z.strictObject({ id: ImageIdSchema }),
    result: z.strictObject({ removed: z.literal(true) }),
    permission: "docker:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 75_000,
  }),
  "docker.volumes.list": unary({
    params: NoParams,
    result: VolumeListSchema,
    permission: "docker:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 30_000,
  }),
  /** Deletes data: requires `docker:delete` (administrators only). */
  "docker.volumes.remove": unary({
    params: z.strictObject({ name: VolumeNameSchema }),
    result: z.strictObject({ removed: z.literal(true) }),
    permission: "docker:delete",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 75_000,
  }),
  "docker.networks.list": unary({
    params: NoParams,
    result: NetworkListSchema,
    permission: "docker:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  "docker.networks.remove": unary({
    params: z.strictObject({ id: NetworkIdSchema }),
    result: z.strictObject({ removed: z.literal(true) }),
    permission: "docker:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 45_000,
  }),
  "docker.compose.projects": unary({
    params: NoParams,
    result: ComposeProjectListSchema,
    permission: "docker:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 15_000,
  }),
  /** Validates a discovered project's Compose files on the host (before import). */
  "docker.compose.check": unary({
    params: z.strictObject({ project: ComposeProjectNameSchema }),
    result: ComposeFileCheckSchema,
    permission: "docker:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 20_000,
  }),
  /**
   * Runs a Compose action for an imported project. The API passes the files it
   * recorded at import; the agent validates them again before running Compose.
   */
  "docker.compose.run": unary({
    params: ComposeActionRequestSchema.extend({
      project: ComposeProjectNameSchema,
      workingDir: z.string().min(1).max(1024),
      configFiles: z.array(ComposeFilePathSchema).min(1).max(16),
    }),
    result: ComposeActionResultSchema,
    permission: "docker:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 11 * 60_000,
  }),
  /** Lifecycle events (healthcheck exec events excluded). */
  "apt.package": unary({
    params: z.strictObject({ name: PackageNameSchema }),
    result: PackageInfoSchema,
    permission: "system:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 45_000,
  }),
  /** `apt-get update`; only an administrator's explicit action, never automatic. */
  "apt.refresh": unary({
    params: NoParams,
    result: AptRefreshResultSchema,
    permission: "system:manage",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 11 * 60_000,
  }),
  /** Upgrades installed packages; never installs new ones or removes any. */
  "apt.upgrade": stream({
    params: AptUpgradeParamsSchema,
    event: AptUpgradeEventSchema,
    permission: "system:manage",
    allowSystemActor: false,
    mutating: true,
    maxDurationMs: 2 * 60 * 60_000,
  }),
  "terminal.status": unary({
    params: NoParams,
    result: TerminalStatusSchema,
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 5_000,
  }),
  /** A shell in a pseudo-terminal, as the configured account; output arrives as events. */
  "terminal.open": stream({
    params: TerminalOpenSchema,
    event: TerminalEventSchema,
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: true,
    maxDurationMs: 12 * 60 * 60_000,
  }),
  /** Keystrokes for the caller's own session (the session itself is audited). */
  "terminal.input": unary({
    params: TerminalInputSchema,
    result: z.object({ accepted: z.literal(true) }),
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 5_000,
  }),
  "terminal.resize": unary({
    params: TerminalResizeSchema,
    result: z.object({ accepted: z.literal(true) }),
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 5_000,
  }),
  "terminal.close": unary({
    params: TerminalCloseSchema,
    result: z.object({ closed: z.boolean() }),
    permission: "terminal:access",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 10_000,
  }),
  /** Archives a stopped managed app's data directory (tar.gz, read in chunks). */
  "backups.appdata.export.begin": unary({
    params: AppDataExportBeginSchema,
    result: AppDataExportBeginResultSchema,
    permission: "backups:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 5 * 60_000,
  }),
  "backups.appdata.export.read": unary({
    params: AppDataExportReadSchema,
    result: AppDataExportReadResultSchema,
    permission: "backups:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 10 * 60_000,
  }),
  "backups.appdata.export.abort": unary({
    params: AppDataTransferAbortSchema,
    result: z.strictObject({ aborted: z.boolean() }),
    permission: "backups:manage",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 30_000,
  }),
  /** Restoring app data: the archive is sent in chunks, then validated and swapped in. */
  "backups.appdata.import.begin": unary({
    params: AppDataImportBeginSchema,
    result: z.strictObject({ token: z.string() }),
    permission: "backups:restore",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "backups.appdata.import.chunk": unary({
    params: AppDataImportChunkSchema,
    result: z.strictObject({ received: z.number().int().nonnegative() }),
    permission: "backups:restore",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 30_000,
  }),
  "backups.appdata.import.commit": unary({
    params: AppDataImportCommitSchema,
    result: AppDataImportResultSchema,
    permission: "backups:restore",
    allowSystemActor: false,
    mutating: true,
    timeoutMs: 6 * 60 * 60_000,
  }),
  "backups.appdata.import.abort": unary({
    params: AppDataTransferAbortSchema,
    result: z.strictObject({ aborted: z.boolean() }),
    permission: "backups:restore",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 30_000,
  }),
  "docker.events": stream({
    params: NoParams,
    event: DockerEventSchema,
    permission: "docker:read",
    allowSystemActor: true,
    mutating: false,
    maxDurationMs: 60 * 60_000,
  }),
} as const;

export type AgentOperations = typeof AGENT_OPERATIONS;
export type OperationName = keyof AgentOperations;

export type UnaryOperationName = {
  [N in OperationName]: AgentOperations[N] extends UnaryContract ? N : never;
}[OperationName];

export type StreamOperationName = {
  [N in OperationName]: AgentOperations[N] extends StreamContract ? N : never;
}[OperationName];

export type OperationParams<N extends OperationName> = z.input<AgentOperations[N]["params"]>;
export type ParsedOperationParams<N extends OperationName> = z.output<AgentOperations[N]["params"]>;

export type OperationResult<N extends UnaryOperationName> =
  AgentOperations[N] extends UnaryContract<z.ZodType, infer R> ? z.output<R> : never;

export type OperationEvent<N extends StreamOperationName> =
  AgentOperations[N] extends StreamContract<z.ZodType, infer E> ? z.output<E> : never;

export function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(AGENT_OPERATIONS, value);
}
