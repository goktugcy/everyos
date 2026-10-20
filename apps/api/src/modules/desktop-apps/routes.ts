import { isAppCapability } from "@everyos/app-manifest";
import {
  DesktopAppIdParamSchema,
  DesktopAppInstallSchema,
  DesktopAppRegistryCreateSchema,
  DesktopAppRegistryIdSchema,
  DesktopAppRegistryUpdateSchema,
  DesktopAppStateSchema,
  DesktopAppUninstallSchema,
  DesktopAppUpdateSchema,
  DesktopAppUserSettingsSchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Empty = z.strictObject({});
const RegistryParam = z.strictObject({ id: DesktopAppRegistryIdSchema });
const ListingParam = DesktopAppIdParamSchema.extend({ registryId: DesktopAppRegistryIdSchema });

/** `/api/desktop-apps`: registries (administrators), the store, and installations. */
export function desktopAppRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { registries, installer, assets, instances } = services.desktopApps;
  const manageRegistries = requirePermission("catalogs:manage");
  const read = requirePermission("apps:read");
  const manage = requirePermission("apps:manage");

  const audited = async <T>(
    c: Context<AppEnv>,
    action: string,
    target: string,
    run: () => T | Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    const { user } = requireAuth(c);
    const record = (outcome: "success" | "failure", extra?: Record<string, unknown>) =>
      services.audit.record({
        action: `desktop-apps.${action}`,
        target,
        outcome,
        actor: { userId: user.id, username: user.username },
        ip: c.get("client").ip,
        ...(details || extra ? { details: { ...details, ...extra } } : {}),
      });
    try {
      const result = await run();
      record("success");
      return result;
    } catch (error) {
      record("failure", { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" });
      throw error;
    }
  };
  const capabilities = (list: string[]) => {
    if (!list.every(isAppCapability))
      throw new ApiError(400, "VALIDATION_FAILED", "Unknown capability");
    return list;
  };

  /* ------------------------------------------------------------ registries */

  app.get("/registries", manageRegistries, (c) => {
    parseQuery(c, Empty);
    return c.json({ registries: registries.list() });
  });
  app.post("/registries", manageRegistries, async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, DesktopAppRegistryCreateSchema);
    const created = await audited(c, "registry.create", input.url, () => registries.create(input), {
      kind: input.kind,
      fingerprint: input.fingerprint,
    });
    return c.json(created, 201);
  });
  app.patch("/registries/:id", manageRegistries, async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, RegistryParam);
    const input = await parseJsonBody(c, DesktopAppRegistryUpdateSchema);
    return c.json(
      await audited(c, "registry.update", id, () => registries.update(id, input), {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.token !== undefined ? { token: input.token === null ? "removed" : "set" } : {}),
      }),
    );
  });
  app.delete("/registries/:id", manageRegistries, async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, RegistryParam);
    await parseJsonBody(c, Empty);
    await audited(c, "registry.delete", id, () => registries.remove(id));
    return c.body(null, 204);
  });
  app.post("/registries/:id/sync", manageRegistries, async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, RegistryParam);
    await parseJsonBody(c, Empty);
    const view = await audited(c, "registry.sync", id, () => registries.sync(id));
    for (const appId of installer.applyRevocations()) instances.closeApp(appId);
    return c.json(view);
  });

  /* ----------------------------------------------------------------- store */

  app.get("/catalog", read, (c) => {
    parseQuery(c, Empty);
    return c.json({ apps: installer.listings() });
  });
  const image = async (
    c: Context<AppEnv>,
    which: { kind: "icon" } | { kind: "screenshot"; index: number },
  ) => {
    const { registryId, appId } = parseParams(
      c,
      ListingParam.extend({ index: z.string().optional() }),
    );
    const registry = registries.usable().find((record) => record.id === registryId);
    if (!registry) throw notFound("Registry");
    const { content, contentType } = await assets.get(registry, appId, which);
    return c.body(new Uint8Array(content), 200, {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      // SVG documents could carry script: never run anything they contain.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  };
  app.get("/catalog/:registryId/:appId/icon", read, (c) => {
    parseQuery(c, Empty);
    return image(c, { kind: "icon" });
  });
  app.get("/catalog/:registryId/:appId/screenshots/:index", read, (c) => {
    parseQuery(c, Empty);
    const { index } = parseParams(
      c,
      ListingParam.extend({ index: z.coerce.number().int().min(0).max(7) }),
    );
    return image(c, { kind: "screenshot", index });
  });

  /* ---------------------------------------------------------- installations */

  app.get("/installed", read, (c) => {
    parseQuery(c, Empty);
    return c.json({ apps: installer.installations() });
  });
  app.post("/installed", manage, async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, DesktopAppInstallSchema);
    const auth = requireAuth(c);
    const installed = await audited(
      c,
      "install",
      input.appId,
      () =>
        installer.install(
          { ...input, approve: capabilities(input.approve) },
          { userId: auth.user.id, permissions: auth.permissions },
        ),
      { registry: input.registryId, approved: input.approve },
    );
    return c.json(installed, 201);
  });
  app.post("/installed/:appId/update", manage, async (c) => {
    parseQuery(c, Empty);
    const { appId } = parseParams(c, DesktopAppIdParamSchema);
    const input = await parseJsonBody(c, DesktopAppUpdateSchema);
    const auth = requireAuth(c);
    return c.json(
      await audited(
        c,
        "update",
        appId,
        () =>
          installer.update(
            appId,
            { ...input, approve: capabilities(input.approve) },
            { userId: auth.user.id, permissions: auth.permissions },
          ),
        { approved: input.approve },
      ).finally(() => instances.closeApp(appId)),
    );
  });
  /** Each person's own choices for an installed app. */
  app.get("/installed/:appId/settings", read, (c) => {
    parseQuery(c, Empty);
    const { appId } = parseParams(c, DesktopAppIdParamSchema);
    if (!installer.installation(appId)) throw notFound("App");
    return c.json(services.desktopApps.settings.get(appId, requireAuth(c).user.id));
  });
  app.put("/installed/:appId/settings", read, async (c) => {
    parseQuery(c, Empty);
    const { appId } = parseParams(c, DesktopAppIdParamSchema);
    const settings = await parseJsonBody(c, DesktopAppUserSettingsSchema);
    if (!installer.installation(appId)) throw notFound("App");
    services.desktopApps.settings.set(appId, requireAuth(c).user.id, settings);
    return c.json(settings);
  });
  app.patch("/installed/:appId", manage, async (c) => {
    parseQuery(c, Empty);
    const { appId } = parseParams(c, DesktopAppIdParamSchema);
    const { enabled } = await parseJsonBody(c, DesktopAppStateSchema);
    return c.json(
      await audited(c, enabled ? "enable" : "disable", appId, () => {
        const view = installer.setEnabled(appId, enabled);
        if (!enabled) instances.closeApp(appId);
        return view;
      }),
    );
  });
  app.delete("/installed/:appId", manage, async (c) => {
    parseQuery(c, Empty);
    const { appId } = parseParams(c, DesktopAppIdParamSchema);
    await parseJsonBody(c, DesktopAppUninstallSchema);
    await audited(c, "uninstall", appId, () => installer.uninstall(appId));
    instances.closeApp(appId);
    return c.body(null, 204);
  });

  return app;
}
