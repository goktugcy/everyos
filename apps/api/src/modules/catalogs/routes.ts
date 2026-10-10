import { CatalogError } from "@otuken/catalogs";
import { CatalogIdSchema, CatalogRequestSchema, CatalogUpdateSchema } from "@otuken/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Empty = z.strictObject({});
const Id = z.strictObject({ id: CatalogIdSchema });
const AppId = z.strictObject({
  id: z
    .string()
    .max(210)
    .regex(/^[a-f0-9-]{36}:[a-z0-9_.-]{1,160}$/),
});

export function catalogRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const catalogs = services.catalogs;
  const audit = (
    c: Context<AppEnv>,
    action: string,
    target: string,
    outcome: "success" | "failure",
    details?: Record<string, unknown>,
  ) => {
    const { user } = requireAuth(c);
    services.audit.record({
      action,
      target,
      outcome,
      actor: { userId: user.id, username: user.username },
      ip: c.get("client").ip,
      ...(details ? { details } : {}),
    });
  };
  const mutate = async <T>(
    c: Context<AppEnv>,
    action: string,
    id: string,
    run: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      const result = await run();
      audit(c, action, id, "success");
      return result;
    } catch (error) {
      const reason = error instanceof CatalogError ? error.reason : "catalog-error";
      audit(c, action, id, "failure", { reason });
      throw new ApiError(
        error instanceof CatalogError && ["sync-in-progress", "catalog-disabled"].includes(reason)
          ? 409
          : 400,
        "BAD_REQUEST",
        "Catalog operation failed",
        { details: { reason } },
      );
    }
  };
  const exists = (id: string) => {
    if (!catalogs.get(id)) throw notFound("Catalog");
  };
  app.get("/", requirePermission("catalogs:manage"), (c) => {
    parseQuery(c, Empty);
    return c.json({ catalogs: catalogs.list() });
  });
  app.post("/", requirePermission("catalogs:manage"), async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, CatalogRequestSchema);
    const result = await mutate(c, "catalogs.create", "catalog", () => catalogs.create(input));
    return c.json(result, 201);
  });
  app.patch("/:id", requirePermission("catalogs:manage"), async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    exists(id);
    const { enabled } = await parseJsonBody(c, CatalogUpdateSchema);
    await mutate(c, "catalogs.update", id, () => catalogs.update(id, enabled));
    return c.json(catalogs.get(id));
  });
  app.delete("/:id", requirePermission("catalogs:manage"), async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    exists(id);
    await parseJsonBody(c, Empty);
    await mutate(c, "catalogs.remove", id, () => catalogs.remove(id));
    return c.body(null, 204);
  });
  app.post("/:id/sync", requirePermission("catalogs:manage"), async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    exists(id);
    await parseJsonBody(c, Empty);
    return c.json(await mutate(c, "catalogs.sync", id, () => catalogs.sync(id)));
  });
  app.get("/apps", requirePermission("apps:read"), (c) => {
    parseQuery(c, Empty);
    return c.json({ apps: catalogs.apps() });
  });
  app.get("/apps/:id/icon", requirePermission("apps:read"), async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, AppId);
    if (!catalogs.app(id)) throw notFound("App");
    try {
      const { content, contentType } = await catalogs.icon(id);
      c.header("Content-Type", contentType);
      c.header("Cache-Control", "private, max-age=3600");
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(new Uint8Array(content).buffer);
    } catch {
      throw notFound("Asset");
    }
  });
  app.get("/apps/:id/screenshots/:index", requirePermission("apps:read"), async (c) => {
    parseQuery(c, Empty);
    const { id, index } = parseParams(
      c,
      AppId.extend({ index: z.coerce.number().int().min(0).max(11) }),
    );
    try {
      const { content, contentType } = await catalogs.screenshot(id, index);
      c.header("Content-Type", contentType);
      c.header("Cache-Control", "private, max-age=3600");
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(new Uint8Array(content).buffer);
    } catch {
      throw notFound("Asset");
    }
  });
  return app;
}
