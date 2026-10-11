import {
  DEFAULT_LOCALE,
  EVERYOS_VERSION,
  type BootstrapResponse,
  type HealthResponse,
} from "@everyos/shared";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import type { Services } from "../../services.ts";

export function healthRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** Liveness/readiness probe. Deliberately reveals no version or host details. */
  app.get("/health", (c) => {
    let database: HealthResponse["checks"]["database"] = "ok";
    try {
      services.db.get("SELECT 1");
    } catch {
      database = "error";
    }
    const agent = services.agent.state === "connected" ? "connected" : "unavailable";
    const body: HealthResponse = {
      status: database === "ok" && agent === "connected" ? "ok" : "degraded",
      checks: { database, agent },
    };
    return c.json(body, database === "ok" ? 200 : 503);
  });

  /** Public information the web client needs before authentication. */
  app.get("/bootstrap", (c) => {
    const client = c.get("client");
    const body: BootstrapResponse = {
      product: "everyos",
      version: EVERYOS_VERSION,
      setupRequired: services.setup.isSetupRequired(),
      defaultLocale: DEFAULT_LOCALE,
      transport: { secure: client.secure, loopback: client.loopback },
      mode: services.config.mode,
    };
    return c.json(body);
  });

  return app;
}
