import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Empty = z.strictObject({});
const Id = z.strictObject({ id: z.string().uuid() });

/** The caller's own server-side transfers (docs/transfers.md); they are started elsewhere. */
export function transferRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("files:read"));
  app.get("/", (c) => {
    parseQuery(c, Empty);
    return c.json({ transfers: services.transfers.list(requireAuth(c).user.id) });
  });
  app.post("/:id/cancel", (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    return c.json(services.transfers.cancel(requireAuth(c).user.id, id));
  });
  /** Forgets finished transfers. */
  app.delete("/", (c) => {
    parseQuery(c, Empty);
    services.transfers.clear(requireAuth(c).user.id);
    return c.body(null, 204);
  });
  return app;
}
