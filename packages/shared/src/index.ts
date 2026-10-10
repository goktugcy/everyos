/*
 * Zod-free entry point, safe for browser bundles. Validation schemas live in
 * "@otuken/shared/schemas"; only their inferred *types* are re-exported here
 * (type-only exports are erased at runtime).
 */
export * from "./api-types.ts";
export * from "./errors.ts";
export * from "./locale.ts";
export * from "./permissions.ts";
export * from "./system.ts";
export type { CapabilityStatus, SystemInfo } from "./schemas/system.ts";
export type {
  CreateUserRequest,
  LoginRequest,
  LoginTotpRequest,
  SetupRequest,
  UpdateUserRequest,
} from "./schemas/api.ts";

/** Single coordinated product version (see docs/decisions.md). */
export const OTUKEN_VERSION = "0.1.0";

/** HTTP header carrying the per-session CSRF token on state-changing requests. */
export const CSRF_HEADER = "x-otuken-csrf";
