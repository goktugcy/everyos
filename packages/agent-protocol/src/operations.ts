import type { Permission } from "@otuken/shared";
import { SystemInfoSchema } from "@otuken/shared/schemas";
import { z } from "zod";

/**
 * Contract for one agent operation. The agent only executes operations that
 * appear in this registry; there is deliberately no generic "run command"
 * operation.
 */
export interface OperationContract<
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  params: P;
  result: R;
  /** Permission the requesting user must hold; null means any authenticated actor. */
  permission: Permission | null;
  /** Whether internal API jobs (actor kind "system") may call this operation. */
  allowSystemActor: boolean;
  /** Mutating operations are always written to the agent audit log. */
  mutating: boolean;
  /** Hard upper bound enforced by the agent; the client uses the same value. */
  timeoutMs: number;
}

function defineOperation<P extends z.ZodType, R extends z.ZodType>(
  contract: OperationContract<P, R>,
): OperationContract<P, R> {
  return contract;
}

export const AGENT_OPERATIONS = {
  "agent.ping": defineOperation({
    params: z.strictObject({}),
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
  "system.info": defineOperation({
    params: z.strictObject({}),
    result: SystemInfoSchema,
    permission: "system:read",
    allowSystemActor: true,
    mutating: false,
    timeoutMs: 5_000,
  }),
} as const;

export type AgentOperations = typeof AGENT_OPERATIONS;
export type OperationName = keyof AgentOperations;
export type OperationParams<N extends OperationName> = z.input<AgentOperations[N]["params"]>;
export type OperationResult<N extends OperationName> = z.output<AgentOperations[N]["result"]>;

export function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(AGENT_OPERATIONS, value);
}
