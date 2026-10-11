import type { ErrorCode } from "@everyos/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly headers: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export const unauthenticated = () =>
  new ApiError(401, "UNAUTHENTICATED", "Authentication required");
export const forbidden = () => new ApiError(403, "FORBIDDEN", "Insufficient permissions");
export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found`);

export function rateLimited(retryAfterMs: number): ApiError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new ApiError(429, "RATE_LIMITED", "Too many attempts", {
    details: { retryAfterSeconds: seconds },
    headers: { "Retry-After": String(seconds) },
  });
}
