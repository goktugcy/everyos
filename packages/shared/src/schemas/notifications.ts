import { z } from "zod";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "../notifications.ts";

const NotificationIdSchema = z.string().uuid();

/** `GET /api/notifications` */
export const NotificationListQuerySchema = z.strictObject({
  severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque cursor from a previous page. */
  before: z.string().max(80).optional(),
});

/** Read/unread/dismiss for listed notifications, or for everything visible. */
export const NotificationStateRequestSchema = z.union([
  z.strictObject({ ids: z.array(NotificationIdSchema).min(1).max(200) }),
  z.strictObject({ all: z.literal(true) }),
]);

/** Per-user notification preferences (preference document `notifications`). */
export const NotificationPreferencesSchema = z.strictObject({
  version: z.literal(1),
  toasts: z.boolean(),
  /** Pop-ups only for this severity or worse. */
  toastMinSeverity: z.enum(NOTIFICATION_SEVERITIES),
  /** Muted categories: listed, but neither counted nor shown as pop-ups. */
  mutedCategories: z.array(z.enum(NOTIFICATION_CATEGORIES)).max(NOTIFICATION_CATEGORIES.length),
});

export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
