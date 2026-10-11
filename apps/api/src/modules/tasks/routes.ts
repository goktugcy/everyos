import {
  TaskCalendarQuerySchema,
  TaskCreateRequestSchema,
  TaskUpdateRequestSchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Id = z.strictObject({ id: z.string().uuid() });

/** Scheduled tasks (docs/tasks.md); every change is audited. */
export function taskRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const tasks = services.tasks;
  app.use("*", requirePermission("tasks:manage"));

  const me = (c: Context<AppEnv>) => {
    const auth = requireAuth(c);
    return { id: auth.user.id, permissions: auth.permissions as ReadonlySet<string> };
  };
  const audit = (
    c: Context<AppEnv>,
    action: string,
    target: string,
    details?: Record<string, unknown>,
  ) => {
    const auth = requireAuth(c);
    services.audit.record({
      action: `tasks.${action}`,
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target,
      ...(details ? { details } : {}),
    });
  };

  app.get("/", (c) =>
    c.json({ tasks: tasks.list(), types: tasks.availableTypes(me(c).permissions) }),
  );

  /** Upcoming runs for calendars (the menu bar pulse). */
  app.get("/calendar", (c) => {
    const { from, to } = parseQuery(c, TaskCalendarQuerySchema);
    return c.json(tasks.calendar(from, to));
  });

  app.get("/:id/runs", (c) => {
    const { id } = parseParams(c, Id);
    return c.json({ runs: tasks.runs(id) });
  });

  app.post("/", async (c) => {
    const input = await parseJsonBody(c, TaskCreateRequestSchema);
    const created = tasks.create(
      {
        name: input.name,
        type: input.type,
        params: input.params,
        schedule: input.schedule,
        enabled: input.enabled,
        notify: input.notify,
        catchUp: input.catchUp,
      },
      me(c),
    );
    audit(c, "create", created.name, { type: created.type, schedule: created.schedule });
    return c.json(created, 201);
  });

  app.patch("/:id", async (c) => {
    const { id } = parseParams(c, Id);
    const patch = await parseJsonBody(c, TaskUpdateRequestSchema);
    const updated = tasks.update(id, patch, me(c));
    audit(c, "update", updated.name, { enabled: updated.enabled, schedule: updated.schedule });
    return c.json(updated);
  });

  app.delete("/:id", (c) => {
    const { id } = parseParams(c, Id);
    const removed = tasks.remove(id, me(c));
    audit(c, "delete", removed.name, { type: removed.type });
    return c.body(null, 204);
  });

  app.post("/:id/run", async (c) => {
    const { id } = parseParams(c, Id);
    await parseJsonBody(c, z.strictObject({}));
    const run = tasks.runNow(id, me(c));
    audit(c, "run-now", tasks.get(id).name);
    return c.json(run, 202);
  });

  app.post("/:id/cancel", async (c) => {
    const { id } = parseParams(c, Id);
    await parseJsonBody(c, z.strictObject({}));
    const cancelled = tasks.cancel(id);
    if (cancelled) audit(c, "cancel", tasks.get(id).name);
    return c.json({ cancelled });
  });

  return app;
}
