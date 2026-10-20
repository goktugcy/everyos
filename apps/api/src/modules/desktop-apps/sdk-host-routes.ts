import { randomBytes } from "node:crypto";
import {
  AppDiskUsageInputSchema,
  AppHostCallSchema,
  AppNotificationSchema,
  LogQuerySchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor, callAgent } from "../../http/agent.ts";
import { ApiError, notFound, rateLimited } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { fileViewFor } from "../files/file-view.ts";
import type { FileView } from "../files/file-view.ts";
import { instanceCall, requireCapability, type InstanceCall } from "./sdk-routes.ts";

const Empty = z.strictObject({});
const SNAPSHOT_MAX_AGE_MS = 15_000;

/** Per app and person: a burst of notifications per minute, and a daily ceiling. */
const NOTIFY_PER_MINUTE = 10;
const NOTIFY_PER_DAY = 200;

const DISK_LIMITS = { entries: 50_000, depth: 32, ms: 15_000, largest: 50 };

interface DiskUsage {
  total: number;
  files: number;
  folders: number;
  truncated: boolean;
  children: Array<{ name: string; kind: "file" | "directory"; size: number; items: number }>;
  largest: Array<{ path: string; size: number }>;
  types: Array<{ extension: string; count: number; size: number }>;
}

/**
 * Sizes inside a folder the person shared with the app: per child, the largest files and file
 * types. Bounded in entries, depth and time; links are never followed.
 */
async function diskUsage(view: FileView, root: string, base: string): Promise<DiskUsage> {
  const deadline = Date.now() + DISK_LIMITS.ms;
  const result: DiskUsage = {
    total: 0,
    files: 0,
    folders: 0,
    truncated: false,
    children: [],
    largest: [],
    types: [],
  };
  const types = new Map<string, { count: number; size: number }>();
  let visited = 0;
  const walk = async (path: string, depth: number): Promise<{ size: number; items: number }> => {
    let size = 0;
    let items = 0;
    if (depth > DISK_LIMITS.depth || Date.now() > deadline || visited > DISK_LIMITS.entries) {
      result.truncated = true;
      return { size, items };
    }
    const listing = await view.list(root, path, true).catch(() => null);
    if (!listing) return { size, items };
    if (listing.truncated) result.truncated = true;
    for (const entry of listing.entries) {
      if (++visited > DISK_LIMITS.entries) {
        result.truncated = true;
        break;
      }
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.type === "file") {
        size += entry.size;
        items += 1;
        result.files += 1;
        const dot = entry.name.lastIndexOf(".");
        const extension =
          dot > 0
            ? entry.name
                .slice(dot + 1)
                .toLowerCase()
                .slice(0, 16)
            : "";
        const type = types.get(extension) ?? { count: 0, size: 0 };
        type.count += 1;
        type.size += entry.size;
        types.set(extension, type);
        result.largest.push({ path: child.slice(base ? base.length + 1 : 0), size: entry.size });
        if (result.largest.length > DISK_LIMITS.largest * 2) {
          result.largest.sort((a, b) => b.size - a.size);
          result.largest.length = DISK_LIMITS.largest;
        }
      } else if (entry.type === "directory") {
        result.folders += 1;
        const inner = await walk(child, depth + 1);
        size += inner.size;
        items += inner.items + 1;
      }
    }
    return { size, items };
  };
  const top = await view.list(root, base, true);
  if (top.truncated) result.truncated = true;
  for (const entry of top.entries) {
    const child = base ? `${base}/${entry.name}` : entry.name;
    if (entry.type === "file") {
      visited += 1;
      result.files += 1;
      result.children.push({ name: entry.name, kind: "file", size: entry.size, items: 1 });
      result.largest.push({ path: entry.name, size: entry.size });
      const dot = entry.name.lastIndexOf(".");
      const extension =
        dot > 0
          ? entry.name
              .slice(dot + 1)
              .toLowerCase()
              .slice(0, 16)
          : "";
      const type = types.get(extension) ?? { count: 0, size: 0 };
      type.count += 1;
      type.size += entry.size;
      types.set(extension, type);
    } else if (entry.type === "directory") {
      result.folders += 1;
      const inner = await walk(child, 1);
      result.children.push({
        name: entry.name,
        kind: "directory",
        size: inner.size,
        items: inner.items,
      });
    }
  }
  result.total = result.children.reduce((sum, child) => sum + child.size, 0);
  result.children.sort((a, b) => b.size - a.size);
  result.largest.sort((a, b) => b.size - a.size);
  result.largest.length = Math.min(result.largest.length, DISK_LIMITS.largest);
  result.types = [...types]
    .map(([extension, value]) => ({ extension, ...value }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 50);
  return result;
}

/** `/api/app-sdk`: notifications and host data, each behind its capability. */
export function appSdkHostRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("apps:read"));
  const sent = new Map<string, number[]>();

  app.post("/notifications", async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, AppNotificationSchema);
    const call = instanceCall(services, c);
    requireCapability(call, "notifications:send");
    const { appId } = call.instance;
    const userId = call.auth.user.id;
    if (!services.desktopApps.settings.notificationsEnabled(appId, userId))
      return c.body(null, 204);
    const now = services.now();
    const key = `${appId}:${userId}`;
    const recent = (sent.get(key) ?? []).filter((at) => now - at < 86_400_000);
    if (
      recent.length >= NOTIFY_PER_DAY ||
      recent.filter((at) => now - at < 60_000).length >= NOTIFY_PER_MINUTE
    )
      throw rateLimited(60_000);
    recent.push(now);
    sent.set(key, recent);
    const manifest = call.manifest;
    services.notifications.publish({
      kind: "app-message",
      // Critical stays the host's: an app can at most warn.
      severity: input.level === "critical" ? "warning" : input.level,
      key: `${appId}:${input.tag ?? randomBytes(8).toString("hex")}`,
      params: { app: manifest.name, appId, title: input.title, body: input.body },
      userId,
    });
    return c.body(null, 204);
  });

  const operations: Record<
    string,
    (c: Context<AppEnv>, call: InstanceCall, input: unknown) => Promise<unknown>
  > = {
    "system.metrics": async () => {
      const latest = services.metrics.latest;
      if (!latest || services.now() - latest.point.at > SNAPSHOT_MAX_AGE_MS)
        await services.metrics.sample();
      const snapshot = services.metrics.latest;
      if (!snapshot) throw new ApiError(503, "AGENT_UNAVAILABLE", "No metrics available yet");
      return snapshot;
    },
    "system.info": (c) => callAgent(c, services, "system.info", {}),
    "system.sockets": (c) => callAgent(c, services, "network.sockets", {}),
    "system.network": (c) => callAgent(c, services, "network.status", {}),
    "logs.query": (c, _call, input) =>
      callAgent(c, services, "logs.query", LogQuerySchema.parse(input ?? {})),
    "disk.usage": async (c, call, input) => {
      const { handle, path } = AppDiskUsageInputSchema.parse(input);
      const grant = services.desktopApps.files.find(
        handle,
        call.instance.appId,
        call.auth.user.id,
        call.instance.id,
      );
      if (grant.kind !== "directory") throw new ApiError(400, "VALIDATION_FAILED", "Not a folder");
      const auth = requireAuth(c);
      const view = fileViewFor(
        services,
        {
          user: auth.user,
          permissions: auth.permissions,
          actor: agentActor(auth, c.get("client").ip),
        },
        { signal: c.req.raw.signal, logger: c.get("logger") },
      );
      const folder = await services.desktopApps.files.resolve(view, grant, path, "directory");
      return diskUsage(view, grant.root, folder.path);
    },
  };
  /** The capability each operation needs (checked on the server, every call). */
  const capabilityOf: Record<string, string> = {
    "system.metrics": "system:metrics.read",
    "system.info": "system:metrics.read",
    "system.sockets": "system:sockets.read",
    "system.network": "system:network.read",
    "logs.query": "logs:read",
    "disk.usage": "storage:usage.read",
  };

  app.post("/host/:operation", async (c) => {
    parseQuery(c, Empty);
    const { operation } = parseParams(
      c,
      z.strictObject({ operation: z.string().regex(/^[a-z]+(\.[a-z]+){1,2}$/) }),
    );
    const { input } = await parseJsonBody(c, AppHostCallSchema);
    const run = operations[operation];
    const capability = capabilityOf[operation];
    if (!run || !capability) throw notFound("Operation");
    const call = instanceCall(services, c);
    requireCapability(call, capability);
    try {
      return c.json({ result: await run(c, call, input) });
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new ApiError(400, "VALIDATION_FAILED", "Invalid input", {
          details: error.issues
            .slice(0, 5)
            .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      throw error;
    }
  });

  return app;
}
