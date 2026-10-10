import {
  IntegrationActionRequestSchema,
  IntegrationCreateRequestSchema,
  IntegrationUpdateRequestSchema,
} from "@otuken/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody, parseParams } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const IdParams = z.strictObject({ id: z.string().uuid() });

/**
 * Application integrations for widgets. Creating one is the administrator's
 * explicit consent for Otuken to read that app's API; credentials are write-only.
 */
export function integrationRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const integrations = services.integrations;
  const invalidate = (id: string) => services.widgetData.invalidate(`data.integration.${id}.`);
  const audit = (
    c: Context<AppEnv>,
    action: string,
    target: string,
    outcome: "success" | "failure" | "denied",
    details?: Record<string, unknown>,
  ) => {
    const auth = requireAuth(c);
    services.audit.record({
      action,
      outcome,
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target,
      ...(details ? { details } : {}),
    });
  };

  app.get("/", requirePermission("apps:read"), (c) =>
    c.json({ integrations: integrations.list(requireAuth(c).permissions) }),
  );

  app.post("/", requirePermission("apps:manage"), async (c) => {
    const input = await parseJsonBody(c, IntegrationCreateRequestSchema);
    const created = integrations.create(input, requireAuth(c).user.id);
    audit(c, "integrations.create", created.name, "success", {
      adapter: created.adapter,
      audience: created.audience,
    });
    return c.json(created, 201);
  });

  app.patch("/:id", requirePermission("apps:manage"), async (c) => {
    const { id } = parseParams(c, IdParams);
    const input = await parseJsonBody(c, IntegrationUpdateRequestSchema);
    const updated = integrations.update(id, input);
    invalidate(id);
    audit(c, "integrations.update", updated.name, "success", {
      audience: updated.audience,
      credentialsChanged: Boolean(input.secret || input.clearSecret),
    });
    return c.json(updated);
  });

  app.delete("/:id", requirePermission("apps:manage"), (c) => {
    const { id } = parseParams(c, IdParams);
    const existing = integrations.get(id);
    if (!existing || !integrations.remove(id)) throw notFound("Integration");
    invalidate(id);
    audit(c, "integrations.delete", existing.name, "success");
    return c.body(null, 204);
  });

  /** Runs the adapter once with the stored settings and reports the outcome. */
  app.post("/:id/test", requirePermission("apps:manage"), async (c) => {
    const { id } = parseParams(c, IdParams);
    const result = await integrations.test(id, c.req.raw.signal);
    return c.json(
      result.status === "ok"
        ? { status: "ok" }
        : result.status === "unavailable"
          ? { status: "unavailable", reason: result.reason }
          : { status: "error", code: result.code },
    );
  });

  /** Home Assistant quick controls (only entities an administrator allowed). */
  app.post("/:id/actions", requirePermission("apps:manage"), async (c) => {
    const { id } = parseParams(c, IdParams);
    const { entityId, service } = await parseJsonBody(c, IntegrationActionRequestSchema);
    const integration = integrations.get(id);
    if (!integration) throw notFound("Integration");
    try {
      await integrations.control(id, entityId, service, c.req.raw.signal);
    } catch (error) {
      audit(
        c,
        "integrations.control",
        `${integration.name}: ${entityId}`,
        error instanceof ApiError && error.status === 403 ? "denied" : "failure",
        {
          service,
        },
      );
      throw error;
    }
    audit(c, "integrations.control", `${integration.name}: ${entityId}`, "success", { service });
    // The entity changed: collect fresh states for widgets.
    services.widgetData.refresh(`data.integration.${id}.states`);
    return c.json({ accepted: true });
  });

  return app;
}
