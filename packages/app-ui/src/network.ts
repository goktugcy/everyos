import { isBridgeError, type NetFailure } from "@everyos/app-sdk";
import type { Translate } from "./app.tsx";
import { errorMessage } from "./files.ts";

const FAILURES: readonly NetFailure[] = [
  "dns",
  "refused",
  "unreachable",
  "timeout",
  "reset",
  "tls",
  "too-many-redirects",
  "invalid-response",
  "error",
];

export type NetworkProblem =
  | { kind: "blocked"; target: string | null; reason: string | null }
  | { kind: "failed"; reason: NetFailure }
  | { kind: "forbidden" }
  | { kind: "rate-limited" };

/** Classifies network bridge failures without trusting the shape of their details. */
export function networkProblem(error: unknown): NetworkProblem | null {
  if (!isBridgeError(error)) return null;
  const details =
    error.details !== null && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : {};
  switch (error.code) {
    case "DESKTOP_APP_NETWORK_BLOCKED": {
      const host = typeof details.host === "string" && details.host ? details.host : null;
      const port =
        typeof details.port === "number" &&
        Number.isInteger(details.port) &&
        details.port >= 1 &&
        details.port <= 65535
          ? details.port
          : null;
      return {
        kind: "blocked",
        target: host
          ? port === null
            ? host
            : `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`
          : null,
        reason: typeof details.reason === "string" ? details.reason : null,
      };
    }
    case "DESKTOP_APP_NETWORK_FAILED":
      return {
        kind: "failed",
        reason: FAILURES.find((reason) => reason === details.reason) ?? "error",
      };
    case "FORBIDDEN":
      return { kind: "forbidden" };
    case "RATE_LIMITED":
      return { kind: "rate-limited" };
    default:
      return null;
  }
}

/** Network errors in the person's language, including how to ask for an allowed target. */
export function networkMessage(t: Translate, error: unknown): string {
  const problem = networkProblem(error);
  switch (problem?.kind) {
    case "blocked":
      return problem.target
        ? t("ui.networkBlocked", { target: problem.target })
        : t("ui.networkForbidden");
    case "failed":
      return t(`ui.networkFailed_${problem.reason}`);
    case "forbidden":
      return t("ui.networkForbidden");
    case "rate-limited":
      return t("ui.networkRateLimited");
    default:
      return errorMessage(t, error);
  }
}
