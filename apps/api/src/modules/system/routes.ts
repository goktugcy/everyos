import {
  EmptyDesktopQuerySchema,
  MetricsHistoryQuerySchema,
  ProcessQuerySchema,
} from "@everyos/shared/schemas";
import type { TailscaleOverview } from "@everyos/shared";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { callAgent } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import { analyzeTailscale } from "./tailscale.ts";
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
  app.get("/power", async (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    return c.json(await callAgent(c, services, "power.status", {}));
  });
  app.get("/hardware", async (c) => c.json(await callAgent(c, services, "hardware.status", {})));
  app.get("/network", async (c) => c.json(await callAgent(c, services, "network.status", {})));
  app.get("/tailscale", async (c) => c.json(await callAgent(c, services, "tailscale.status", {})));

  /** Tailscale in detail, with remote-access analysis and warnings (docs/tailscale.md). */
  app.get("/tailscale/overview", async (c) => {
    const [status, details] = await Promise.all([
      callAgent(c, services, "tailscale.status", {}),
      callAgent(c, services, "tailscale.details", {}),
    ]);
    const overview: TailscaleOverview = {
      status,
      details,
      ...analyzeTailscale({
        status,
        details,
        server: services.config.server,
        isTrustedProxy: services.isTrustedProxy,
        now: services.now(),
      }),
      canSeePeers: requireAuth(c).permissions.has("system:manage"),
    };
    return c.json(overview);
  });

  /** The tailnet's other devices; administrators only. */
  app.get("/tailscale/peers", requirePermission("system:manage"), async (c) =>
    c.json(await callAgent(c, services, "tailscale.peers", {})),
  );

  app.get("/processes", async (c) => {
    const query = parseQuery(c, ProcessQuerySchema);
    return c.json(await callAgent(c, services, "processes.list", query));
  });

  return app;
}
