import { PackageNameSchema, UpgradeRequestSchema } from "@everyos/shared/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor, toApiError } from "../../http/agent.ts";
import { notFound } from "../../http/errors.ts";
import { openEventStream, untilAborted } from "../../http/event-stream.ts";
import { parseJsonBody, parseParams } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import type { UpdateJobEvent } from "./update-service.ts";

const JobParams = z.strictObject({ id: z.string().uuid() });
const PackageParams = z.strictObject({ name: PackageNameSchema });

/** The update manager (docs/updates.md); changes need system:manage and an explicit request. */
export function updateRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const updates = services.updates;
  const actor = (c: Parameters<typeof requireAuth>[0]) =>
    agentActor(requireAuth(c), c.get("client").ip);
  app.use("*", requirePermission("system:read"));

  app.get("/", async (c) => {
    try {
      return c.json({
        updates: await services.agent.call("apt.updates", {}, actor(c)),
        running: updates.jobs().find((job) => job.status === "running") ?? null,
      });
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.get("/packages/:name", async (c) => {
    const { name } = parseParams(c, PackageParams);
    try {
      return c.json(await services.agent.call("apt.package", { name }, actor(c)));
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.get("/jobs", (c) => c.json({ jobs: updates.jobs() }));

  app.get("/jobs/:id", (c) => {
    const { id } = parseParams(c, JobParams);
    const job = updates.job(id);
    if (!job) throw notFound("Update job");
    return c.json(job);
  });

  /** Live apt output (`event: line`) until `event: done`. */
  app.get("/jobs/:id/events", (c) => {
    const { id } = parseParams(c, JobParams);
    if (!updates.job(id)) throw notFound("Update job");
    return openEventStream(c, services, {
      permissions: ["system:read"],
      async run(channel) {
        const queue: UpdateJobEvent[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = updates.subscribe(id, (event) => {
          queue.push(event);
          wake?.();
        });
        try {
          const current = updates.job(id)!;
          if (current.status !== "running") {
            await channel.send("done", current);
            return;
          }
          while (!channel.signal.aborted) {
            const event = queue.shift();
            if (!event) {
              await Promise.race([
                new Promise<void>((resolve) => {
                  wake = resolve;
                }),
                untilAborted(channel.signal),
              ]);
              wake = null;
              continue;
            }
            if (event.type === "line") await channel.send("line", { text: event.text });
            else {
              await channel.send("done", event.job);
              return;
            }
          }
        } finally {
          unsubscribe();
        }
      },
    });
  });

  app.post("/refresh", requirePermission("system:manage"), async (c) => {
    await parseJsonBody(c, z.strictObject({}));
    return c.json(updates.start("refresh", null, actor(c)), 202);
  });

  app.post("/upgrade", requirePermission("system:manage"), async (c) => {
    const body = await parseJsonBody(c, UpgradeRequestSchema);
    return c.json(
      updates.start("upgrade", "packages" in body ? body.packages : null, actor(c)),
      202,
    );
  });

  return app;
}
