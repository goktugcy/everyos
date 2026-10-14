import { ROLE_PERMISSIONS, type Permission } from "@everyos/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../context.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { Services } from "../services.ts";

export interface EventChannel {
  /** Aborts when the client disconnects or loses access. */
  readonly signal: AbortSignal;
  send: (event: string, data: unknown, id?: string) => Promise<void>;
}

export interface EventStreamOptions {
  /** Every permission the stream needs; re-checked while it is open. */
  permissions: readonly Permission[];
  run(channel: EventChannel): Promise<void>;
  /** How often access is re-checked and a keep-alive comment is sent. */
  heartbeatMs?: number;
  /** Maps a failure to a code (and optional display message) sent to the client before closing. */
  describeError?: (error: unknown) => string | { code: string; message: string };
}

/**
 * Server-sent events with the same guarantees as normal requests: a stream
 * ends as soon as the session is locked, revoked or expires, the account is
 * disabled, or the user's role no longer grants the required permissions.
 * Writes apply backpressure: a slow client stalls its own stream only.
 */
export function openEventStream(
  c: Context<AppEnv>,
  services: Services,
  options: EventStreamOptions,
): Response {
  const auth = requireAuth(c);
  const logger = c.get("logger");
  const controller = new AbortController();
  const request = c.req.raw.signal;
  if (request.aborted) controller.abort();
  else request.addEventListener("abort", () => controller.abort(), { once: true });

  const stillAllowed = () => {
    const session = services.sessions.peek(auth.session.id);
    if (!session || session.lockedAt !== null) return false;
    const user = services.users.findById(auth.user.id);
    if (!user || user.disabled) return false;
    return options.permissions.every((permission) => ROLE_PERMISSIONS[user.role].has(permission));
  };

  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    const heartbeat = setInterval(() => {
      if (!stillAllowed()) {
        logger.debug("Closing event stream: access changed");
        controller.abort();
        return;
      }
      stream.write(": keep-alive\n\n").catch(() => controller.abort());
    }, options.heartbeatMs ?? services.eventStreamHeartbeatMs);
    heartbeat.unref();
    try {
      await stream.writeSSE({ event: "ready", data: "{}", retry: 5_000 });
      await options.run({
        signal: controller.signal,
        send: (event, data, id) =>
          stream.writeSSE({
            event,
            data: JSON.stringify(data),
            ...(id !== undefined ? { id } : {}),
          }),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn("Event stream failed", { error });
        const described = options.describeError?.(error) ?? "INTERNAL_ERROR";
        await stream
          .writeSSE({
            event: "error",
            data: JSON.stringify(typeof described === "string" ? { code: described } : described),
          })
          .catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeat);
      controller.abort();
    }
  });
}

/** Resolves once the signal aborts. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
