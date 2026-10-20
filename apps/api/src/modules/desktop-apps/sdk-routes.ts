import { capabilityInfo, type AppManifest } from "@everyos/app-manifest";
import type { Permission } from "@everyos/shared";
import {
  AppInstanceOpenSchema,
  AppStorageKeySchema,
  AppStorageKeysSchema,
  AppStorageSetSchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound, rateLimited } from "../../http/errors.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import type { AppInstance } from "./instances.ts";

export const INSTANCE_HEADER = "x-everyos-app-instance";
const Empty = z.strictObject({});

/** What an installation may do for this person: its grants that the person's role allows. */
export function effectiveGrants(
  granted: ReadonlySet<string>,
  permissions: ReadonlySet<Permission>,
): string[] {
  return [...granted].filter((capability) =>
    capabilityInfo(capability as never).requires.every((permission) =>
      permissions.has(permission as Permission),
    ),
  );
}

export interface InstanceCall {
  auth: ReturnType<typeof requireAuth>;
  instance: AppInstance;
  manifest: AppManifest;
  granted: ReadonlySet<string>;
}

const denied = (capability: string) =>
  new ApiError(403, "FORBIDDEN", "The app may not do this", { details: { capability } });

/**
 * Resolves the calling instance (its token must belong to this session and user), checks the app
 * is still active and spends one request of the instance's rate budget.
 */
export function instanceCall(services: Services, c: Context<AppEnv>): InstanceCall {
  const auth = requireAuth(c);
  const { instances, installer } = services.desktopApps;
  const instance = instances.resolve(c.req.header(INSTANCE_HEADER), auth.session.id);
  if (!instance || instance.userId !== auth.user.id)
    throw new ApiError(401, "UNAUTHENTICATED", "Unknown app instance");
  const active = installer.active(instance.appId);
  if (!active) {
    instances.close(instance.token);
    throw notFound("App");
  }
  if (!instances.take(instance)) throw rateLimited(1000);
  return { auth, instance, manifest: active.manifest, granted: active.granted };
}

/**
 * The server-side authorization of every SDK call: the capability is granted to the installation,
 * the person's role allows it, and a widget frame stays within its widget's declared subset.
 */
export function requireCapability(call: InstanceCall, capability: string): void {
  if (!call.granted.has(capability)) throw denied(capability);
  for (const permission of capabilityInfo(capability as never).requires)
    if (!call.auth.permissions.has(permission as Permission)) throw denied(capability);
  if (call.instance.kind === "widget") {
    const widget = call.manifest.widgets.find((entry) => entry.id === call.instance.widgetId);
    if (!widget?.permissions.includes(capability as never)) throw denied(capability);
  }
}

/** `/api/app-sdk`: calls the desktop makes on behalf of a running app. */
export function appSdkRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { installer, instances, storage } = services.desktopApps;
  app.use("*", requirePermission("apps:read"));

  app.post("/instances", async (c) => {
    parseQuery(c, Empty);
    const { appId, kind, widgetId } = await parseJsonBody(c, AppInstanceOpenSchema);
    const auth = requireAuth(c);
    const active = installer.active(appId);
    if (!active) throw notFound("App");
    if (kind === "widget" && !active.manifest.widgets.some((widget) => widget.id === widgetId))
      throw notFound("Widget");
    const instance = instances.open({
      appId,
      userId: auth.user.id,
      sessionId: auth.session.id,
      kind,
      widgetId: kind === "widget" ? (widgetId ?? null) : null,
    });
    return c.json(
      { token: instance.token, granted: effectiveGrants(active.granted, auth.permissions) },
      201,
    );
  });

  app.delete("/instances/current", async (c) => {
    parseQuery(c, Empty);
    await parseJsonBody(c, Empty);
    const auth = requireAuth(c);
    const instance = instances.resolve(c.req.header(INSTANCE_HEADER), auth.session.id);
    if (instance) instances.close(instance.token);
    return c.body(null, 204);
  });

  /* ---------------------------------------------------------------- storage */

  const withStorage = (c: Context<AppEnv>) => {
    const call = instanceCall(services, c);
    requireCapability(call, "storage:app");
    return { appId: call.instance.appId, userId: call.auth.user.id };
  };
  app.post("/storage/get", async (c) => {
    parseQuery(c, Empty);
    const { key } = await parseJsonBody(c, AppStorageKeySchema);
    const { appId, userId } = withStorage(c);
    return c.json({ entry: storage.get(appId, userId, key) });
  });
  app.post("/storage/set", async (c) => {
    parseQuery(c, Empty);
    const { key, value } = await parseJsonBody(c, AppStorageSetSchema);
    const { appId, userId } = withStorage(c);
    storage.set(appId, userId, key, value);
    return c.body(null, 204);
  });
  app.post("/storage/delete", async (c) => {
    parseQuery(c, Empty);
    const { key } = await parseJsonBody(c, AppStorageKeySchema);
    const { appId, userId } = withStorage(c);
    storage.delete(appId, userId, key);
    return c.body(null, 204);
  });
  app.post("/storage/keys", async (c) => {
    parseQuery(c, Empty);
    const { prefix } = await parseJsonBody(c, AppStorageKeysSchema);
    const { appId, userId } = withStorage(c);
    return c.json({ keys: storage.keys(appId, userId, prefix) });
  });
  app.get("/storage/usage", (c) => {
    parseQuery(c, Empty);
    const { appId, userId } = withStorage(c);
    return c.json(storage.usage(appId, userId));
  });
  app.post("/storage/clear", async (c) => {
    parseQuery(c, Empty);
    await parseJsonBody(c, Empty);
    const { appId, userId } = withStorage(c);
    storage.clear(appId, userId);
    return c.body(null, 204);
  });

  return app;
}
