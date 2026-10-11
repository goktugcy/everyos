import { AppInstallRequestSchema, CatalogIdSchema } from "@everyos/shared/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { openEventStream } from "../../http/event-stream.ts";
import { notFound, ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Empty = z.strictObject({});
const Id = z.strictObject({ id: CatalogIdSchema });
const Action = z.strictObject({
  action: z.enum(["retry", "start", "stop", "restart", "update", "remove"]),
  confirmId: CatalogIdSchema.optional(),
});
export function appRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const actor = (c: Parameters<typeof requireAuth>[0]) =>
    agentActor(requireAuth(c), c.get("client").ip);
  app.get("/", requirePermission("apps:read"), async (c) => {
    parseQuery(c, Empty);
    return c.json({ apps: await services.apps.list(actor(c)) });
  });
  app.post("/install", requirePermission("apps:manage"), async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, AppInstallRequestSchema);
    try {
      return c.json(await services.apps.install(input, actor(c)), 202);
    } catch (error) {
      const auth = requireAuth(c);
      services.audit.record({
        action: "apps.install",
        target: input.appId,
        outcome: error instanceof ApiError && error.status === 403 ? "denied" : "failure",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        details: { reason: error instanceof ApiError ? error.code : "INTERNAL_ERROR" },
      });
      throw error;
    }
  });
  app.post("/:id/actions", requirePermission("apps:manage"), async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, Action);
    try {
      if (
        ["retry", "remove", "stop", "restart", "update"].includes(input.action) &&
        input.confirmId !== id
      )
        throw new ApiError(422, "VALIDATION_FAILED", "Application confirmation required");
      return c.json(await services.apps.control(id, input.action, actor(c)), 202);
    } catch (error) {
      const auth = requireAuth(c);
      services.audit.record({
        action: `apps.${input.action}`,
        target: id,
        outcome: error instanceof ApiError && error.status === 403 ? "denied" : "failure",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        details: { reason: error instanceof ApiError ? error.code : "INTERNAL_ERROR" },
      });
      throw error;
    }
  });
  app.post("/:id/reconcile", requirePermission("apps:manage"), async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    await parseJsonBody(c, Empty);
    try {
      return c.json(await services.apps.reconcile(id, actor(c)));
    } catch (error) {
      const auth = requireAuth(c);
      services.audit.record({
        action: "apps.reconcile",
        target: id,
        outcome: error instanceof ApiError && error.status === 403 ? "denied" : "failure",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        details: { reason: error instanceof ApiError ? error.code : "INTERNAL_ERROR" },
      });
      throw error;
    }
  });
  app.get("/jobs/:id", requirePermission("apps:read"), (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    const job = services.apps.job(id);
    if (!job) throw notFound("Job");
    return c.json(job);
  });
  app.get("/jobs/:id/events", requirePermission("apps:read"), (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    if (!services.apps.job(id)) throw notFound("Job");
    return openEventStream(c, services, {
      permissions: ["apps:read"],
      async run({ signal, send }) {
        for await (const job of services.apps.events(id, signal)) await send("progress", job);
        if (!signal.aborted) await send("end", {});
      },
    });
  });
  return app;
}
