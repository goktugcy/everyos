import {
  DiskMountSchema,
  DiskUnmountRequestSchema,
  EmptyDesktopQuerySchema,
  MetricsHistoryQuerySchema,
  PowerRequestSchema,
  ProcessQuerySchema,
} from "@everyos/shared/schemas";
import type { TailscaleOverview } from "@everyos/shared";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { agentActor, callAgent } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { confirmPassword } from "../../http/reauth.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import { powerBlockers } from "./power.ts";
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
  /** Disks and volumes; the system disk is listed for information only (docs/disks.md). */
  app.get("/disks", async (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    const auth = requireAuth(c);
    return c.json(
      await services.disks.list(agentActor(auth, c.get("client").ip), c.req.raw.signal),
    );
  });
  app.post("/disks/mount", requirePermission("system:manage"), async (c) => {
    const input = await parseJsonBody(c, DiskMountSchema);
    const auth = requireAuth(c);
    return c.json(
      await services.disks.mount(
        input.uuid,
        input.persistent,
        agentActor(auth, c.get("client").ip),
      ),
    );
  });
  app.post("/disks/unmount", requirePermission("system:manage"), async (c) => {
    const input = await parseJsonBody(c, DiskUnmountRequestSchema);
    if (input.confirm !== input.uuid)
      throw new ApiError(422, "VALIDATION_FAILED", "Disk confirmation required");
    const auth = requireAuth(c);
    return c.json(await services.disks.unmount(input.uuid, agentActor(auth, c.get("client").ip)));
  });
  app.get("/power/reboot", async (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    return c.json(await callAgent(c, services, "power.reboot.status", {}));
  });
  /** What a restart or power-off would interrupt, shown before the administrator confirms. */
  app.get("/power/blockers", requirePermission("system:manage"), async (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    return c.json({ blockers: await powerBlockers(services, c) });
  });
  /** Restarts or powers off the host: password re-check, repeated action and a running-work check. */
  app.post("/power", requirePermission("system:manage"), async (c) => {
    const input = await parseJsonBody(c, PowerRequestSchema);
    if (input.confirm !== input.action)
      throw new ApiError(422, "VALIDATION_FAILED", "Power action confirmation required");
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "system.power");
    const blockers = await powerBlockers(services, c);
    if (blockers.includes("release-install") || (blockers.length > 0 && input.force !== true))
      throw new ApiError(409, "CONFLICT", "Other work is running", {
        details: { reason: "busy", blockers },
      });
    const result = await callAgent(c, services, "power.control", { action: input.action });
    services.audit.record({
      action: "system.power",
      target: input.action,
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      details: { forced: blockers.length > 0, blockers: blockers.join(",") },
    });
    services.notifications.publish({
      kind: "power-scheduled",
      severity: "warning",
      key: input.action,
      params: { power: input.action, user: auth.user.username },
    });
    return c.json(result, 202);
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
