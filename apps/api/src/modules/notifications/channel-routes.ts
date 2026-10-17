import { NotificationChannelInputSchema } from "@everyos/shared/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Empty = z.strictObject({});
const Id = z.strictObject({ id: z.string().uuid() });

/** External notification channels; administrators only, credentials never returned. */
export function notificationChannelRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const channels = services.notificationChannels;
  const actor = (c: Parameters<typeof requireAuth>[0]) =>
    agentActor(requireAuth(c), c.get("client").ip);
  app.use("*", requirePermission("system:manage"));
  app.get("/", (c) => {
    parseQuery(c, Empty);
    return c.json({ channels: channels.list() });
  });
  app.post("/", async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, NotificationChannelInputSchema);
    return c.json(channels.create(input, actor(c)), 201);
  });
  app.put("/:id", async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, NotificationChannelInputSchema);
    return c.json(channels.update(id, input, actor(c)));
  });
  app.delete("/:id", async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, z.strictObject({ confirmId: z.string().uuid() }));
    if (input.confirmId !== id)
      throw new ApiError(422, "VALIDATION_FAILED", "Channel deletion confirmation required");
    channels.remove(id, actor(c));
    return c.body(null, 204);
  });
  app.post("/:id/test", async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    await parseJsonBody(c, Empty);
    await channels.test(id, actor(c));
    return c.json(channels.get(id));
  });
  return app;
}
