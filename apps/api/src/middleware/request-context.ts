import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.ts";
import { resolveClientInfo } from "../http/client-info.ts";
import type { Services } from "../services.ts";

const QUIET_PATHS = new Set(["/api/health"]);

/** Assigns a request id, resolves client info and logs each request. */
export function requestContext(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = randomBytes(8).toString("hex");
    const socket = c.env?.incoming?.socket as Partial<TLSSocket> | undefined;
    const client = resolveClientInfo(
      { remoteAddress: socket?.remoteAddress, encrypted: socket?.encrypted === true },
      (name) => c.req.header(name),
      services.isTrustedProxy,
    );
    const logger = services.logger.child({ requestId });
    c.set("requestId", requestId);
    c.set("client", client);
    c.set("logger", logger);
    c.set("auth", null);
    c.header("X-Request-Id", requestId);

    const started = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
      ip: client.ip,
    };
    // Successful reads (polling, static files) stay at debug to keep journald
    // writes low; state changes and failures are always visible at info.
    const routine =
      QUIET_PATHS.has(c.req.path) ||
      !c.req.path.startsWith("/api/") ||
      (c.req.method === "GET" && c.res.status < 400);
    if (routine) logger.debug("request", fields);
    else logger.info("request", fields);
  };
}
