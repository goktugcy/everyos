/**
 * Stable, machine-readable error codes returned by the API and the agent.
 * The web client localizes them via the `errors.<CODE>` translation keys, so
 * every code listed here must exist in each locale (enforced by a test).
 */
export const ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_ERROR",
  "CSRF_FAILED",
  "SETUP_ALREADY_COMPLETED",
  "SETUP_TOKEN_INVALID",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_ACCOUNT_DISABLED",
  "AUTH_TOTP_REQUIRED",
  "AUTH_TOTP_INVALID",
  "AUTH_CHALLENGE_EXPIRED",
  "AUTH_PASSWORD_POLICY",
  "AUTH_CURRENT_PASSWORD_INVALID",
  "TOTP_ALREADY_ENABLED",
  "TOTP_NOT_ENABLED",
  "TOTP_ENROLLMENT_MISSING",
  "USER_USERNAME_TAKEN",
  "USER_LAST_ADMIN",
  "USER_CANNOT_MODIFY_SELF",
  "AGENT_UNAVAILABLE",
  "AGENT_TIMEOUT",
  "AGENT_OPERATION_FAILED",
  "AGENT_OPERATION_DENIED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
