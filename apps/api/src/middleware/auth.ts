import { ROLE_PERMISSIONS, type Permission } from "@everyos/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, AuthState } from "../context.ts";
import { ApiError, forbidden, unauthenticated } from "../http/errors.ts";
import { readSessionToken } from "../modules/auth/session-cookie.ts";
import type { Services } from "../services.ts";
import { needsTwoFactorSetup } from "../modules/auth/two-factor-policy.ts";

/**
 * Resolves the session cookie into an authenticated user. Permissions are
 * recomputed from the user's current role on every request, so role changes
 * and account disabling take effect immediately.
 */
export function loadSession(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readSessionToken(c);
    if (token) {
      const session = services.sessions.validate(token);
      if (session) {
        const user = services.users.findById(session.userId);
        if (user && !user.disabled) {
          c.set("auth", { user, session, permissions: ROLE_PERMISSIONS[user.role] });
          c.set("logger", c.get("logger").child({ userId: user.id }));
        } else {
          services.sessions.revoke(session.id);
        }
      }
    }
    await next();
  };
}

export function requireAuth(c: Context<AppEnv>): AuthState {
  const auth = c.get("auth");
  if (!auth) throw unauthenticated();
  return auth;
}

export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = requireAuth(c);
    if (!auth.permissions.has(permission)) {
      c.get("logger").warn("Permission denied", { permission, path: c.req.path });
      throw forbidden();
    }
    await next();
  };
}

export const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireAuth(c);
  await next();
};

/** Requests a locked session may still make (everything else gets 423). */
const ALLOWED_WHILE_LOCKED = new Set([
  "GET /api/health",
  "GET /api/bootstrap",
  "GET /api/auth/session",
  "POST /api/auth/unlock",
  "POST /api/auth/logout",
  "GET /api/preferences",
]);

/**
 * Enforces session locking on the server. The lock screen in the browser is
 * only a view; a locked session cannot access host or account data until the
 * user re-enters their password. Public bootstrap and appearance reads allow
 * the lock screen to render after a page reload.
 */
export const enforceUnlocked: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (auth && auth.session.lockedAt !== null) {
    const route = `${c.req.method} ${c.req.path}`;
    const wallpaperImage =
      c.req.method === "GET" && /^\/api\/wallpapers\/[^/]+\/image$/.test(c.req.path);
    if (!ALLOWED_WHILE_LOCKED.has(route) && !wallpaperImage) {
      throw new ApiError(423, "SESSION_LOCKED", "Session is locked");
    }
  }
  await next();
};

/** Requests an account may make while the policy requires a two-factor setup it has not done. */
const ALLOWED_BEFORE_TWO_FACTOR = new Set([
  "GET /api/health",
  "GET /api/bootstrap",
  "GET /api/auth/session",
  "POST /api/auth/logout",
  "POST /api/auth/lock",
  "POST /api/auth/unlock",
  "GET /api/preferences",
  "POST /api/account/totp/enroll",
  "POST /api/account/totp/enable",
]);

/**
 * Enforces the two-factor policy on the server: an account it covers without a second factor
 * reaches only its two-factor setup (and sign-out) until it has one.
 */
export function enforceTwoFactor(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth && needsTwoFactorSetup(services.db, auth.user)) {
      const route = `${c.req.method} ${c.req.path}`;
      const wallpaperImage =
        c.req.method === "GET" && /^\/api\/wallpapers\/[^/]+\/image$/.test(c.req.path);
      if (!ALLOWED_BEFORE_TWO_FACTOR.has(route) && !wallpaperImage)
        throw new ApiError(403, "TWO_FACTOR_REQUIRED", "Two-factor authentication is required");
    }
    await next();
  };
}
