import type { Permission } from "@otuken/shared";
import {
  HardwareStatusSchema,
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
  UnitNameSchema,
} from "@otuken/shared/schemas";
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
  mutating: false;
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
  "processes.list": unary({
    params: ProcessQuerySchema,
    result: ProcessListSchema,
    permission: "system:read",
    allowSystemActor: false,
    mutating: false,
    timeoutMs: 10_000,
  }),
  "services.list": unary({
    params: NoParams,
    result: ServiceListSchema,
    permission: "services:read",
    allowSystemActor: false,
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
  "logs.follow": stream({
    params: LogFilterSchema.omit({ since: true, until: true }),
    event: LogEntrySchema,
    permission: "logs:read",
    allowSystemActor: false,
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
