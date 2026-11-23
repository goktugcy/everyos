import { Hono } from "hono";
import { z } from "zod";
import {
  SharingConnectionInputSchema,
  SharingFolderInputSchema,
  SharingIdParamsSchema,
  SharingControlSchema,
  SharingProbeSchema,
} from "@everyos/shared/schemas";
import type { Context } from "hono";
import type { AppEnv } from "../../context.ts";
import type { Services } from "../../services.ts";
import { agentActor, callAgent } from "../../http/agent.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { ApiError } from "../../http/errors.ts";
import { QuickShareInputSchema } from "@everyos/shared/schemas";

const Empty = z.strictObject({});
const Confirm = z.strictObject({ confirm: z.literal(true) });
export function sharingRoutes(services: Services) {
  const app = new Hono<AppEnv>();
  const actor = (c: Context<AppEnv>) => agentActor(requireAuth(c), c.get("client").ip);
  app.use("*", requirePermission("files:read"));
  app.use("*", async (c, next) => {
    await next();
    const auth = c.get("auth");
    if (auth && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.res.status >= 400)
      services.sharing.audit(
        agentActor(auth, c.get("client").ip),
        "request",
        c.req.path,
        "failure",
      );
  });
  app.get("/", async (c) => {
    parseQuery(c, Empty);
    return c.json({
      ...(await services.sharing.status(actor(c), c.req.raw.signal)),
      quickShares: services.quickShares.list(requireAuth(c).user.id),
    });
  });
  app.post("/probe", requirePermission("files:write"), async (c) => {
    const p = await parseJsonBody(c, SharingProbeSchema);
    const result = await services.sharing.probe(p.host, p.port, p.protocol, actor(c).userId);
    services.sharing.audit(actor(c), "connection.probe", p.protocol + ":" + p.host + ":" + p.port);
    return c.json(result);
  });
  app.post("/connections", requirePermission("files:write"), async (c) =>
    c.json(
      await services.sharing.save(await parseJsonBody(c, SharingConnectionInputSchema), actor(c)),
      201,
    ),
  );
  app.put("/connections/:id", requirePermission("files:write"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    return c.json(
      await services.sharing.save(
        await parseJsonBody(c, SharingConnectionInputSchema),
        actor(c),
        id,
      ),
    );
  });
  app.post("/connections/:id/control", requirePermission("files:write"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    const { action } = await parseJsonBody(c, SharingControlSchema);
    await services.sharing.control(id, action, actor(c));
    return c.body(null, 204);
  });
  app.delete("/connections/:id", requirePermission("files:write"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    await parseJsonBody(c, Confirm);
    await services.sharing.remove(id, actor(c));
    return c.body(null, 204);
  });
  app.post("/folders", requirePermission("system:manage"), async (c) =>
    c.json(
      await services.sharing.saveShare(await parseJsonBody(c, SharingFolderInputSchema), actor(c)),
      201,
    ),
  );
  app.put("/folders/:id", requirePermission("system:manage"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    return c.json(
      await services.sharing.saveShare(
        await parseJsonBody(c, SharingFolderInputSchema),
        actor(c),
        id,
      ),
    );
  });
  app.delete("/folders/:id", requirePermission("system:manage"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    await parseJsonBody(c, Confirm);
    await services.sharing.removeShare(id, actor(c));
    return c.body(null, 204);
  });
  app.post("/services/install", requirePermission("system:manage"), async (c) => {
    const { protocol } = await parseJsonBody(
      c,
      Confirm.extend({
        protocol: z.enum(["nfs", "smb", "sftp", "discovery", "nfs-client", "smb-client"]),
      }),
    );
    await callAgent(c, services, "sharing.install", { protocol });
    services.sharing.audit(actor(c), "service.install", protocol);
    return c.json({ accepted: true }, 202);
  });
  app.post("/services/control", requirePermission("system:manage"), async (c) => {
    const { protocol, action } = await parseJsonBody(
      c,
      Confirm.extend({
        protocol: z.enum(["nfs", "smb", "sftp", "discovery"]),
        action: z.enum(["start", "reload"]),
      }),
    );
    await callAgent(c, services, "sharing.service", { protocol, action });
    services.sharing.audit(actor(c), "service." + action, protocol);
    return c.body(null, 204);
  });
  app.post("/smb/account", requirePermission("system:manage"), async (c) => {
    const { username, password } = await parseJsonBody(
      c,
      Confirm.extend({
        username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}\$?$/),
        password: z
          .string()
          .min(12)
          .max(1024)
          .refine((v) => !/[\0\r\n]/.test(v)),
      }),
    );
    await callAgent(c, services, "sharing.smb.account", { username, password });
    services.sharing.audit(actor(c), "smb.account", username);
    return c.body(null, 204);
  });
  app.get("/discover", async (c) => {
    parseQuery(c, Empty);
    return c.json(await callAgent(c, services, "sharing.discover", {}));
  });
  app.post("/quick", requirePermission("files:write"), async (c) => {
    const client = c.get("client");
    if (!client.secure && !client.loopback)
      throw new ApiError(
        400,
        "SHARING_HTTPS_REQUIRED",
        "Use EveryOS HTTPS before creating a share",
      );
    const result = await services.quickShares.create(
      await parseJsonBody(c, QuickShareInputSchema),
      actor(c),
    );
    return c.json({ ...result, url: client.expectedOrigin + "/share#" + result.token }, 201);
  });
  app.get("/quick/:id/link", (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    return c.json({
      url: c.get("client").expectedOrigin + "/share#" + services.quickShares.link(id, actor(c)),
    });
  });
  app.post("/quick/:id/revoke", requirePermission("files:write"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    await parseJsonBody(c, Confirm);
    services.quickShares.revoke(id, actor(c));
    return c.body(null, 204);
  });
  app.delete("/quick/:id", requirePermission("files:write"), async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    await parseJsonBody(c, Confirm);
    services.quickShares.remove(id, actor(c));
    return c.body(null, 204);
  });
  return app;
}
