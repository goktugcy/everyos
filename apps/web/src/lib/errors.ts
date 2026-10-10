import type { TFunction } from "i18next";
import { ApiRequestError } from "./api.ts";

/** Converts any thrown value into a localized, user-facing message. */
export function errorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "RATE_LIMITED")
      return t("errors.RATE_LIMITED", { seconds: error.retryAfterSeconds ?? 60 });
    return t(`errors.${error.code}`);
  }
  return t("errors.UNKNOWN");
}

/** Password policy violations reported by the API, if any. */
export function passwordViolations(error: unknown): string[] {
  if (!(error instanceof ApiRequestError) || error.code !== "AUTH_PASSWORD_POLICY") return [];
  const details = error.details as { violations?: unknown } | undefined;
  return Array.isArray(details?.violations)
    ? details.violations.filter((v): v is string => typeof v === "string")
    : [];
}
