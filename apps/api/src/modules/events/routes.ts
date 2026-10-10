import type { MetricsSnapshot, Permission } from "@otuken/shared";
import { EventStreamQuerySchema } from "@otuken/shared/schemas";
import type { EventTopic } from "@otuken/shared";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { forbidden } from "../../http/errors.ts";
import { openEventStream, untilAborted } from "../../http/event-stream.ts";
import { parseQuery } from "../../http/validation.ts";
import { authenticated, requireAuth } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const TOPIC_PERMISSIONS: Record<EventTopic, Permission> = {
  metrics: "system:read",
};

/**
 * One multiplexed server-sent event stream per browser tab:
 * `GET /api/events?topics=metrics`. Each topic requires its own permission.
 */
export function eventRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", authenticated, (c) => {
    const { topics } = parseQuery(c, EventStreamQuerySchema);
    const auth = requireAuth(c);
    const permissions = topics.map((topic) => TOPIC_PERMISSIONS[topic]);
    if (!permissions.every((permission) => auth.permissions.has(permission))) throw forbidden();

    return openEventStream(c, services, {
      permissions,
      async run({ signal, send }) {
        const unsubscribers: Array<() => void> = [];
        if (topics.includes("metrics")) {
          // Latest wins: a slow client skips snapshots instead of queueing them.
          let sending = false;
          unsubscribers.push(
            services.metrics.subscribe((snapshot: MetricsSnapshot) => {
              if (sending || signal.aborted) return;
              sending = true;
              send("metrics", snapshot)
                .catch(() => undefined)
                .finally(() => {
                  sending = false;
                });
            }),
          );
        }
        try {
          await untilAborted(signal);
        } finally {
          for (const unsubscribe of unsubscribers) unsubscribe();
        }
      },
    });
  });

  return app;
}
