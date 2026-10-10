import { permissionsForRole, type SessionInfo } from "@otuken/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../../context.ts";
import type { Services } from "../../services.ts";
import { toPublicUser, type User } from "../users/user-repository.ts";
import type { Session } from "./session-service.ts";

/** Plain-HTTP cookie name. */
export const SESSION_COOKIE = "otuken_session";
/** HTTPS cookie name; the __Host- prefix forbids Domain and requires Secure + Path=/. */
export const SECURE_SESSION_COOKIE = "__Host-otuken_session";

function useSecureCookie(c: Context<AppEnv>, services: Services): boolean {
  switch (services.config.security.cookieSecure) {
    case "always":
      return true;
    case "never":
      return false;
    case "auto":
      return c.get("client").secure;
  }
}

export function readSessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SECURE_SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(
  c: Context<AppEnv>,
  services: Services,
  token: string,
  expiresAt: number,
): void {
  const secure = useSecureCookie(c, services);
  setCookie(c, secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt - services.now()) / 1000)),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, SECURE_SESSION_COOKIE, { path: "/", secure: true });
}

export function buildSessionInfo(services: Services, user: User, session: Session): SessionInfo {
  return {
    user: toPublicUser(user),
    permissions: permissionsForRole(user.role),
    csrfToken: services.sessions.csrfToken(session.id),
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: services.sessions.effectiveExpiry(session),
      locked: session.lockedAt !== null,
    },
  };
}

/** Creates a session after successful authentication and sets the cookie. */
export function startSession(c: Context<AppEnv>, services: Services, user: User): SessionInfo {
  const client = c.get("client");
  const { session, token } = services.sessions.create(user.id, {
    ip: client.ip,
    userAgent: c.req.header("user-agent") ?? null,
  });
  services.users.recordLogin(user.id);
  setSessionCookie(c, services, token, session.expiresAt);
  return buildSessionInfo(services, user, session);
}
