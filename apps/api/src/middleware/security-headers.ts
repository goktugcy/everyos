import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.ts";
import type { Services } from "../services.ts";

/**
 * Strict default headers. The CSP forbids inline and remote scripts, so even
 * if untrusted catalog text were ever rendered unsafely it could not execute.
 * Inline styles stay allowed because UI libraries position elements with
 * style attributes.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
    );
    if (c.req.path.startsWith("/api/") && !headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }
    if (services.config.security.hsts && c.get("client").secure) {
      headers.set("Strict-Transport-Security", "max-age=31536000");
    }
  };
}
