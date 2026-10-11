import {
  NotificationListQuerySchema,
  NotificationStateRequestSchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../context.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import type { NotificationViewer } from "./notification-service.ts";

const viewer = (c: Context<AppEnv>): NotificationViewer => {
  const auth = requireAuth(c);
  return { id: auth.user.id, permissions: auth.permissions };
};

/** The signed-in user's notification center. State changes only affect the caller. */
export function notificationRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const notifications = services.notifications;
  app.use("*", requirePermission("notifications:read"));

  app.get("/", (c) => {
    const query = parseQuery(c, NotificationListQuerySchema);
    const me = viewer(c);
    return c.json({
      ...notifications.list(me, {
        severity: query.severity,
        category: query.category,
        unread: query.unread === "true",
        limit: query.limit,
        before: query.before,
      }),
      unread: notifications.counts(me),
    });
  });

  app.post("/read", async (c) => {
    const target = await parseJsonBody(c, NotificationStateRequestSchema);
    const me = viewer(c);
    notifications.setRead(me, target, true);
    return c.json({ unread: notifications.counts(me) });
  });

  app.post("/unread", async (c) => {
    const target = await parseJsonBody(c, NotificationStateRequestSchema);
    const me = viewer(c);
    notifications.setRead(me, target, false);
    return c.json({ unread: notifications.counts(me) });
  });

  app.post("/dismiss", async (c) => {
    const target = await parseJsonBody(c, NotificationStateRequestSchema);
    const me = viewer(c);
    notifications.dismiss(me, target);
    return c.json({ unread: notifications.counts(me) });
  });

  return app;
}
