import type { Locale } from "./locale.ts";
import type { Permission, Role } from "./permissions.ts";

/*
 * Response contracts of the HTTP API. Request bodies are validated with the
 * zod schemas in "@everyos/shared/schemas"; their inferred types are
 * re-exported from the package root as type-only exports so browser bundles
 * never include zod.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export interface HealthResponse {
  status: "ok" | "degraded";
  checks: {
    database: "ok" | "error";
    agent: "connected" | "unavailable";
  };
}

export interface BootstrapResponse {
  product: "everyos";
  version: string;
  setupRequired: boolean;
  defaultLocale: Locale;
  transport: {
    /** True when the browser reached EveryOS over HTTPS (directly or via a trusted proxy). */
    secure: boolean;
    /** True when the client connected from the loopback interface. */
    loopback: boolean;
  };
  mode: "production" | "development";
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  locale: Locale;
  totpEnabled: boolean;
  createdAt: number;
}

export interface AdminUserView extends PublicUser {
  disabled: boolean;
  lastLoginAt: number | null;
}

export interface SessionInfo {
  user: PublicUser;
  permissions: Permission[];
  csrfToken: string;
  session: {
    id: string;
    createdAt: number;
    expiresAt: number;
    /** A locked session only accepts unlock, logout and session reads. */
    locked: boolean;
  };
  /**
   * The server requires two-factor authentication for this account's role and it is not set up
   * yet: until it is, the session only reaches the two-factor setup.
   */
  twoFactorSetupRequired: boolean;
}

/** Who must use two-factor authentication (docs/security-model.md). */
export const TWO_FACTOR_POLICIES = ["nobody", "admins", "everyone"] as const;
export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number];

export interface TwoFactorPolicyView {
  required: TwoFactorPolicy;
  /** Active accounts the policy covers that have not set up two-factor authentication yet. */
  pending: Array<Pick<PublicUser, "id" | "username" | "displayName">>;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export type LoginResponse =
  | { status: "authenticated"; session: SessionInfo }
  | { status: "totp_required"; challengeId: string; expiresAt: number };

export interface TotpEnrollmentResponse {
  secret: string;
  otpauthUri: string;
}

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditEvent {
  id: number;
  ts: number;
  actorUserId: string | null;
  actorUsername: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: number | null;
}
