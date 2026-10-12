import type { TFunction } from "i18next";
import { linuxErrorMessage } from "../../lib/errors.ts";

export function updateJobError(t: TFunction, error: string): string {
  const linux = linuxErrorMessage(t, error);
  if (linux) return linux;
  if (error === "busy") return t("updates.errors.busy");
  if (error === "DEVELOPMENT_MODE") return t("updates.errors.development");
  if (error === "AGENT_UNAVAILABLE") return t("errors.AGENT_UNAVAILABLE");
  if (error === "AGENT_TIMEOUT") return t("errors.AGENT_TIMEOUT");
  if (error === "AGENT_OPERATION_DENIED") return t("errors.AGENT_OPERATION_DENIED");
  if (error === "AGENT_OPERATION_FAILED" || error === "AGENT_INVALID_RESPONSE")
    return t("errors.AGENT_OPERATION_FAILED");
  if (error === "HOST_CAPABILITY_UNAVAILABLE") return t("errors.HOST_CAPABILITY_UNAVAILABLE");
  return t("updates.errors.failed");
}
