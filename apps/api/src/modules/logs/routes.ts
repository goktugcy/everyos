import { LogFilterSchema, LogQuerySchema } from "@everyos/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { agentActor, callAgent, toApiError } from "../../http/agent.ts";
import { openEventStream } from "../../http/event-stream.ts";
import { parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const LogStreamQuerySchema = LogFilterSchema.omit({ since: true, until: true });

export function logRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("logs:read"));

  app.get("/", async (c) => {
    const query = parseQuery(c, LogQuerySchema);
    return c.json(await callAgent(c, services, "logs.query", query));
  });

  /**
   * Live journal entries as server-sent events (`entry`). The agent ends a
   * stream after its maximum duration with an `end` event; EventSource
   * clients simply reconnect.
   */
  app.get("/stream", (c) => {
    const filter = parseQuery(c, LogStreamQuerySchema);
    const actor = agentActor(requireAuth(c), c.get("client").ip);
    return openEventStream(c, services, {
      permissions: ["logs:read"],
      describeError: (error) => toApiError(error).code,
      async run({ signal, send }) {
        for await (const entry of services.agent.stream("logs.follow", filter, actor, { signal })) {
          await send("entry", entry, entry.cursor);
        }
        if (!signal.aborted) await send("end", {});
      },
    });
  });

  return app;
}
