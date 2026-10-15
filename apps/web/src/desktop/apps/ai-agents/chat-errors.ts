import type { AiAgentKind } from "@everyos/shared";
import type { TFunction } from "i18next";
import { ApiRequestError } from "../../../lib/api.ts";

const CHAT_ERROR_REASONS = ["auth", "offline", "status", "invalid", "too-large"] as const;

/** The agent's own failure reason when it gave one, instead of a generic system error. */
export function chatError(t: TFunction, kind: AiAgentKind, error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.code !== "AGENT_OPERATION_FAILED") return null;
  const { reason, message } = (error.details ?? {}) as { reason?: unknown; message?: unknown };
  const agent = t(`aiAgents.names.${kind}`);
  if (reason === "agent-error")
    return typeof message === "string" && message
      ? t("aiAgents.chatErrors.agentReason", { agent, message })
      : t("aiAgents.chatErrors.agent", { agent });
  const known = CHAT_ERROR_REASONS.find((value) => value === reason);
  return known ? t(`aiAgents.chatErrors.${known}`, { agent }) : null;
}

/** Turns a chat stream's `error` event into the same error the chat window shows. */
export function streamError(data: { code?: unknown; message?: unknown }): ApiRequestError {
  return new ApiRequestError(502, "AGENT_OPERATION_FAILED", "Agent chat failed", {
    reason: typeof data.code === "string" ? data.code : "offline",
    message: typeof data.message === "string" ? data.message : undefined,
  });
}
