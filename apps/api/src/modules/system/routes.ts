import { MetricsHistoryQuerySchema, ProcessQuerySchema } from "@otuken/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { callAgent } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseQuery } from "../../http/validation.ts";
import { requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

export { agentActor, toApiError } from "../../http/agent.ts";

/** A snapshot older than this is refreshed before answering a one-off request. */
const SNAPSHOT_MAX_AGE_MS = 5_000;

export function systemRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("system:read"));

  app.get("/info", async (c) => c.json(await callAgent(c, services, "system.info", {})));

  /** Latest live metrics, for clients that do not keep an event stream open. */
  app.get("/metrics", async (c) => {
    const latest = services.metrics.latest;
    if (!latest || services.now() - latest.point.at > SNAPSHOT_MAX_AGE_MS)
      await services.metrics.sample();
    const snapshot = services.metrics.latest;
    if (!snapshot) throw new ApiError(503, "AGENT_UNAVAILABLE", "No metrics available yet");
    return c.json(snapshot);
  });

  app.get("/metrics/history", (c) => {
    const { range } = parseQuery(c, MetricsHistoryQuerySchema);
    return c.json(services.metrics.history(range));
  });

  app.get("/storage", async (c) => c.json(await callAgent(c, services, "storage.usage", {})));
  app.get("/hardware", async (c) => c.json(await callAgent(c, services, "hardware.status", {})));
  app.get("/network", async (c) => c.json(await callAgent(c, services, "network.status", {})));
  app.get("/tailscale", async (c) => c.json(await callAgent(c, services, "tailscale.status", {})));

  app.get("/processes", async (c) => {
    const query = parseQuery(c, ProcessQuerySchema);
    return c.json(await callAgent(c, services, "processes.list", query));
  });

  return app;
}
