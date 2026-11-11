import { Hono } from "hono";
import { z } from "zod";
import {
  RemoteAccessParamsSchema,
  RemoteAccessConfigureSchema,
  RemoteAccessConnectRequestSchema,
  RemoteAccessInstallRequestSchema,
} from "@everyos/shared/schemas";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { remoteAccessProviders } from "./providers.ts";

const Empty = z.strictObject({});
export function remoteAccessRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>(),
    remote = remoteAccessProviders(services);
  app.use("*", requirePermission("system:read"));
  app.get("/", async (c) => {
    parseQuery(c, Empty);
    const auth = requireAuth(c);
    return c.json(
      await remote.overview(
        agentActor(auth, c.get("client").ip),
        auth.permissions.has("system:manage"),
      ),
    );
  });
  app.get("/:provider/peers", requirePermission("system:manage"), async (c) => {
    parseQuery(c, Empty);
    const { provider } = parseParams(c, RemoteAccessParamsSchema);
    return c.json({
      peers: await remote.providers[provider].peers(agentActor(requireAuth(c), c.get("client").ip)),
    });
  });
  app.put("/:provider/settings", requirePermission("system:manage"), async (c) => {
    parseQuery(c, Empty);
    const { provider } = parseParams(c, RemoteAccessParamsSchema),
      { confirm: _confirm, ...settings } = await parseJsonBody(c, RemoteAccessConfigureSchema);
    return c.json(
      remote.providers[provider].configure(
        settings,
        agentActor(requireAuth(c), c.get("client").ip),
      ),
    );
  });
  app.post("/:provider/install", requirePermission("system:manage"), async (c) => {
    parseQuery(c, Empty);
    const { provider } = parseParams(c, RemoteAccessParamsSchema),
      body = await parseJsonBody(c, RemoteAccessInstallRequestSchema);
    return c.json(
      await remote.providers[provider].install(
        body.configureRepository,
        agentActor(requireAuth(c), c.get("client").ip),
      ),
      202,
    );
  });
  app.post("/:provider/connect", requirePermission("system:manage"), async (c) => {
    parseQuery(c, Empty);
    const { provider } = parseParams(c, RemoteAccessParamsSchema),
      body = await parseJsonBody(c, RemoteAccessConnectRequestSchema);
    return c.json(
      await remote.providers[provider].connect(
        body.credential,
        body.acknowledgeConflicts,
        agentActor(requireAuth(c), c.get("client").ip),
      ),
    );
  });
  app.post("/:provider/disconnect", requirePermission("system:manage"), async (c) => {
    parseQuery(c, Empty);
    const { provider } = parseParams(c, RemoteAccessParamsSchema);
    await parseJsonBody(c, z.strictObject({ confirm: z.literal(true) }));
    return c.json(
      await remote.providers[provider].disconnect(agentActor(requireAuth(c), c.get("client").ip)),
    );
  });
  return app;
}
