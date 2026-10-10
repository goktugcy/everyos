import { AuditQuerySchema } from "@otuken/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { parseQuery } from "../../http/validation.ts";
import { requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

export function auditRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", requirePermission("audit:read"), (c) => {
    const query = parseQuery(c, AuditQuerySchema);
    return c.json(
      services.audit.query({ limit: query.limit, before: query.before, action: query.action }),
    );
  });
  return app;
}
