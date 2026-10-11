import {
  AgentClientError,
  type Actor,
  type OperationParams,
  type OperationResult,
  type UnaryOperationName,
} from "@everyos/agent-protocol";
import type { Context } from "hono";
import type { AppEnv, AuthState } from "../context.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { Services } from "../services.ts";
import { ApiError, notFound } from "./errors.ts";

export type UserActor = Extract<Actor, { kind: "user" }>;

/** Identity forwarded to the agent so it can re-check permissions and audit. */
export function agentActor(auth: AuthState, ip: string): UserActor {
  return {
    kind: "user",
    userId: auth.user.id,
    username: auth.user.username,
    role: auth.user.role,
    sessionId: auth.session.id,
    ip: ip.slice(0, 64),
  };
}

/** Agent error codes that have a more precise HTTP meaning than their client error class. */
const AGENT_CODE_ERRORS: Partial<Record<string, (error: AgentClientError) => ApiError>> = {
  not_found: () => notFound(),
  unsupported: () =>
    new ApiError(501, "HOST_CAPABILITY_UNAVAILABLE", "This host does not support the operation"),
  busy: () => new ApiError(429, "RATE_LIMITED", "Too many concurrent operations"),
  conflict: (error) => new ApiError(409, "CONFLICT", error.message.slice(0, 300)),
  invalid_params: () => new ApiError(400, "VALIDATION_FAILED", "Invalid parameters"),
  // Policy reasons are written by the agent for display (e.g. protected units).
  policy_denied: (error) =>
    new ApiError(403, "AGENT_OPERATION_DENIED", "Denied by the agent policy", {
      details: { reason: error.message.slice(0, 300) },
    }),
};

/** Maps agent failures to stable API errors without leaking internals. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (!(error instanceof AgentClientError)) {
    return new ApiError(502, "AGENT_OPERATION_FAILED", "Agent operation failed");
  }
  const specific = AGENT_CODE_ERRORS[error.agentCode ?? ""];
  if (specific) return specific(error);
  switch (error.code) {
    case "AGENT_UNAVAILABLE":
      return new ApiError(503, "AGENT_UNAVAILABLE", "The system agent is not available");
    case "AGENT_TIMEOUT":
      return new ApiError(504, "AGENT_TIMEOUT", "The system agent did not respond in time");
    case "AGENT_OPERATION_DENIED":
      return new ApiError(403, "AGENT_OPERATION_DENIED", "Denied by the agent policy");
    case "AGENT_OPERATION_FAILED":
    case "AGENT_INVALID_RESPONSE":
      return new ApiError(502, "AGENT_OPERATION_FAILED", "Agent operation failed");
  }
}

/** Calls a unary agent operation on behalf of the signed-in user. */
export async function callAgent<N extends UnaryOperationName>(
  c: Context<AppEnv>,
  services: Services,
  op: N,
  params: OperationParams<N>,
): Promise<OperationResult<N>> {
  const auth = requireAuth(c);
  try {
    return await services.agent.call(op, params, agentActor(auth, c.get("client").ip), {
      signal: c.req.raw.signal,
    });
  } catch (error) {
    // A client that navigates away (or React re-running an effect in dev)
    // aborts its request; that is routine, not a failure worth a warning.
    const logger = c.get("logger");
    if (!(error instanceof AgentClientError)) logger.warn("Agent operation failed", { op, error });
    else if (
      c.req.raw.signal.aborted ||
      error.agentCode === "not_found" ||
      error.agentCode === "conflict" ||
      error.agentCode === "unsupported"
    ) {
      logger.debug("Agent operation did not complete", { op, code: error.agentCode });
    } else if (error.agentCode === "policy_denied") {
      // Expected outcome of the agent policy (also audited); no stack trace needed.
      logger.info("Agent operation denied by policy", { op, reason: error.message });
    } else {
      logger.warn("Agent operation failed", {
        op,
        code: error.code,
        agentCode: error.agentCode,
        message: error.message,
      });
    }
    throw toApiError(error);
  }
}
