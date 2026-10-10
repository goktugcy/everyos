import { AgentClientError, type Actor } from "@otuken/agent-protocol";
import { Hono } from "hono";
import type { AppEnv, AuthState } from "../../context.ts";
import { ApiError } from "../../http/errors.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

/** Identity forwarded to the agent so it can re-check permissions and audit. */
export function agentActor(auth: AuthState, ip: string): Actor {
  return {
    kind: "user",
    userId: auth.user.id,
    username: auth.user.username,
    role: auth.user.role,
    sessionId: auth.session.id,
    ip: ip.slice(0, 64),
  };
}

/** Maps agent failures to stable API errors without leaking internals. */
export function toApiError(error: unknown): ApiError {
  if (!(error instanceof AgentClientError)) {
    return new ApiError(502, "AGENT_OPERATION_FAILED", "Agent operation failed");
  }
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

export function systemRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/info", requirePermission("system:read"), async (c) => {
    const auth = requireAuth(c);
    try {
      const info = await services.agent.call(
        "system.info",
        {},
        agentActor(auth, c.get("client").ip),
        {
          signal: c.req.raw.signal,
        },
      );
      return c.json(info);
    } catch (error) {
      c.get("logger").warn("system.info failed", { error });
      throw toApiError(error);
    }
  });

  return app;
}
