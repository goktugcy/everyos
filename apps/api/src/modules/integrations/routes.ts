import {
  IntegrationActionRequestSchema,
  IntegrationCreateRequestSchema,
  IntegrationUpdateRequestSchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { HOME_ASSISTANT_BRANDS } from "@everyos/shared";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody, parseParams } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { audiencePermissions } from "./integration-service.ts";
import { homeAssistantBrandIcon } from "./home-assistant-brands.ts";

const IdParams = z.strictObject({ id: z.string().uuid() });
const BrandParams = z.strictObject({ id: z.string().uuid(), brand: z.enum(HOME_ASSISTANT_BRANDS) });

/**
 * Application integrations for widgets. Creating one is the administrator's
 * explicit consent for EveryOS to read that app's API; credentials are write-only.
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

  app.get("/:id/brand/:brand", requirePermission("apps:read"), async (c) => {
    const { id, brand } = parseParams(c, BrandParams);
    const allowed = () => {
      const integration = integrations.get(id);
      if (!integration || integration.adapter !== "homeassistant") throw notFound("Integration");
      if (
        !audiencePermissions(integration.audience).every((p) => requireAuth(c).permissions.has(p))
      )
        throw new ApiError(403, "FORBIDDEN", "Integration is not shared with this user");
    };
    allowed();
    const bytes = await homeAssistantBrandIcon(brand);
    allowed();
    if (!bytes) throw notFound("Brand icon");
    return c.body(new Uint8Array(bytes).buffer, 200, {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
    });
  });

  /** Fresh Home Assistant states for the panel, with the same audience as its shared topic. */
  app.get("/:id/states", requirePermission("apps:read"), async (c) => {
    const { id } = parseParams(c, IdParams);
    const integration = integrations.get(id);
    if (!integration) throw notFound("Integration");
    if (!audiencePermissions(integration.audience).every((p) => requireAuth(c).permissions.has(p)))
      throw new ApiError(403, "FORBIDDEN", "Integration data is not shared with this user");
    if (integration.adapter !== "homeassistant")
      throw new ApiError(400, "VALIDATION_FAILED", "This integration has no Home Assistant states");
    const result = await integrations.test(id, c.req.raw.signal);
    const current = integrations.get(id);
    if (!current) throw notFound("Integration");
    if (!audiencePermissions(current.audience).every((p) => requireAuth(c).permissions.has(p)))
      throw new ApiError(403, "FORBIDDEN", "Integration data is no longer shared with this user");
    if (
      current.updatedAt !== integration.updatedAt ||
      JSON.stringify(current.options) !== JSON.stringify(integration.options)
    )
      throw new ApiError(409, "CONFLICT", "Integration settings changed during collection");
    return c.json({ ...result, at: services.now() });
  });

  app.post("/", requirePermission("apps:manage"), async (c) => {
    const input = await parseJsonBody(c, IntegrationCreateRequestSchema);
    const created = integrations.create(input, requireAuth(c).user.id);
    audit(c, "integrations.create", created.name, "success", {
      adapter: created.adapter,
      audience: created.audience,
      ...(created.adapter === "homeassistant"
        ? {
            entityScope: created.options.entityScope ?? "selected",
            controlScope: created.options.controlScope ?? "selected",
          }
        : {}),
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
      ...(updated.adapter === "homeassistant"
        ? {
            entityScope: updated.options.entityScope ?? "selected",
            controlScope: updated.options.controlScope ?? "selected",
          }
        : {}),
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
    const input = await parseJsonBody(c, IntegrationActionRequestSchema);
    const { entityId, service } = input;
    const integration = integrations.get(id);
    if (!integration) throw notFound("Integration");
    try {
      await integrations.control(id, input, c.req.raw.signal);
    } catch (error) {
      audit(
        c,
        "integrations.control",
        `${integration.name}: ${entityId}`,
        error instanceof ApiError && error.status === 403 ? "denied" : "failure",
        {
          service,
          ...(input.service === "configure" ? { control: input.control } : {}),
        },
      );
      throw error;
    }
    audit(c, "integrations.control", `${integration.name}: ${entityId}`, "success", {
      service,
      ...(input.service === "configure" ? { control: input.control } : {}),
    });
    // The entity changed: collect fresh states for widgets.
    services.widgetData.refresh(`data.integration.${id}.states`);
    return c.json({ accepted: true });
  });

  return app;
}
