import { ROLE_PERMISSIONS, type Permission } from "@otuken/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, AuthState } from "../context.ts";
import { forbidden, unauthenticated } from "../http/errors.ts";
import { readSessionToken } from "../modules/auth/session-cookie.ts";
import type { Services } from "../services.ts";

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
