import { EVENT_TOPICS, type EventTopic, type Permission, type TopicMessage } from "@otuken/shared";
import { EventStreamQuerySchema } from "@otuken/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { forbidden } from "../../http/errors.ts";
import { openEventStream, untilAborted, type EventChannel } from "../../http/event-stream.ts";
import { parseQuery } from "../../http/validation.ts";
import { authenticated, requireAuth } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const TOPIC_PERMISSIONS: Record<EventTopic, Permission> = {
  metrics: "system:read",
  docker: "docker:read",
};

/**
 * Sends `event` messages with "latest wins" semantics: while one write is in
 * flight, newer data replaces older pending data instead of queueing, so a
 * slow client never builds up a backlog. (Clients refetch on change events,
 * so only the most recent one matters.)
 */
function latestWins<T>(channel: EventChannel, event: string): (data: T) => void {
  let sending = false;
  let pending: { data: T } | null = null;
  const flush = (data: T) => {
    sending = true;
    channel
      .send(event, data)
      .catch(() => undefined)
      .finally(() => {
        sending = false;
        const next = pending;
        pending = null;
        if (next && !channel.signal.aborted) flush(next.data);
      });
  };
  return (data) => {
    if (channel.signal.aborted) return;
    if (sending) pending = { data };
    else flush(data);
  };
}

const isStreamTopic = (topic: string): topic is EventTopic =>
  (EVENT_TOPICS as readonly string[]).includes(topic);

/**
 * One multiplexed server-sent event stream per browser tab:
 * `GET /api/events?topics=metrics,docker,data.storage,…`. Live topics need
 * their permission up front; shared data topics (`event: data`) are checked
 * per topic, so one forbidden widget does not break the others.
 */
export function eventRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", authenticated, (c) => {
    const { topics } = parseQuery(c, EventStreamQuerySchema);
    const auth = requireAuth(c);
    const streams = topics.filter(isStreamTopic);
    const dataTopics = topics.filter((topic) => !isStreamTopic(topic));
    const streamPermissions = streams.map((topic) => TOPIC_PERMISSIONS[topic]);
    if (!streamPermissions.every((permission) => auth.permissions.has(permission)))
      throw forbidden();
    // Data topics the user may read now; losing one of these permissions later closes the stream.
    const dataPermissions = dataTopics.flatMap((topic) => {
      const provider = services.widgetData.provider(topic);
      return provider && provider.permissions.every((p) => auth.permissions.has(p))
        ? provider.permissions
        : [];
    });

    return openEventStream(c, services, {
      permissions: [...new Set([...streamPermissions, ...dataPermissions])],
      async run(channel) {
        const unsubscribers: Array<() => void> = [];
        if (streams.includes("metrics")) {
          unsubscribers.push(services.metrics.subscribe(latestWins(channel, "metrics")));
        }
        if (streams.includes("docker")) {
          const stats = latestWins(channel, "docker.stats");
          const change = latestWins(channel, "docker.change");
          unsubscribers.push(
            services.docker.subscribe((message) =>
              message.kind === "stats" ? stats(message.snapshot) : change(message.event),
            ),
          );
        }
        for (const topic of dataTopics) {
          // "Latest wins" per topic: a slow client gets the newest value of each, not a backlog.
          const send = latestWins<TopicMessage>(channel, "data");
          unsubscribers.push(services.widgetData.subscribe(topic, auth.permissions, send));
        }
        try {
          await untilAborted(channel.signal);
        } finally {
          for (const unsubscribe of unsubscribers) unsubscribe();
        }
      },
    });
  });

  return app;
}
