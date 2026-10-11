import { CSRF_HEADER } from "@everyos/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import type { Services } from "../services.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const csrfFailed = (reason: string) =>
  new ApiError(403, "CSRF_FAILED", `CSRF check failed: ${reason}`);

/**
 * Defence in depth against cross-site request forgery for state-changing
 * requests:
 *  1. Fetch metadata: browsers label cross-site requests (Sec-Fetch-Site).
 *  2. Origin must match the origin the browser used (or a configured one).
 *  3. Authenticated requests must echo the per-session CSRF token header.
 * The session cookie is additionally SameSite=Strict.
 */
export function csrfProtection(services: Services): MiddlewareHandler<AppEnv> {
  const allowedOrigins = new Set(services.config.server.publicOrigins);
  // Credential-submission endpoints do not act with an existing session's
  // authority, so they need no session token (origin checks still apply).
  const tokenExempt = new Set(["/api/setup", "/api/auth/login", "/api/auth/login/totp"]);
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw csrfFailed(`sec-fetch-site=${fetchSite}`);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const expected = c.get("client").expectedOrigin;
      if (origin !== expected && !allowedOrigins.has(origin)) {
        c.get("logger").warn("Rejected request with foreign origin", { origin, expected });
        throw csrfFailed("origin mismatch");
      }
    }
    const auth = c.get("auth");
    if (
      auth &&
      !tokenExempt.has(c.req.path) &&
      !services.sessions.verifyCsrfToken(auth.session.id, c.req.header(CSRF_HEADER))
    ) {
      throw csrfFailed("missing or invalid token");
    }
    await next();
  };
}
