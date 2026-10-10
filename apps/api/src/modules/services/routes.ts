import { ServiceActionRequestSchema, UnitNameSchema } from "@otuken/shared/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { callAgent } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseParams } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const UnitParamsSchema = z.strictObject({ unit: UnitNameSchema });

export function serviceRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", requirePermission("services:read"), async (c) =>
    c.json(await callAgent(c, services, "services.list", {})),
  );

  app.get("/:unit", requirePermission("services:read"), async (c) => {
    const { unit } = parseParams(c, UnitParamsSchema);
    return c.json(await callAgent(c, services, "services.get", { unit }));
  });

  app.post("/:unit/actions", requirePermission("services:manage"), async (c) => {
    const auth = requireAuth(c);
    const { unit } = parseParams(c, UnitParamsSchema);
    const { action } = await parseJsonBody(c, ServiceActionRequestSchema);
    const audit = (outcome: "success" | "failure" | "denied", reason?: string) =>
      services.audit.record({
        action: `services.${action}`,
        outcome,
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        target: unit,
        ...(reason ? { details: { reason } } : {}),
      });
    try {
      await callAgent(c, services, "services.control", { unit, action });
    } catch (error) {
      const denied = error instanceof ApiError && error.status === 403;
      const reason =
        error instanceof ApiError
          ? ((error.details as { reason?: string } | undefined)?.reason ?? error.code)
          : undefined;
      audit(denied ? "denied" : "failure", reason);
      throw error;
    }
    audit("success");
    return c.json({ accepted: true }, 202);
  });

  return app;
}
