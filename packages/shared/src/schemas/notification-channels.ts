import { z } from "zod";
import {
  EMAIL_SECURITY,
  NOTIFICATION_CHANNEL_LANGUAGES,
  WEBHOOK_FORMATS,
} from "../notification-channels.ts";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "../notifications.ts";

const Secret = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
/** http(s) without embedded credentials; query strings are allowed (some webhooks carry keys). */
const HttpUrl = z
  .url()
  .max(2048)
  .regex(/^https?:\/\/[^/?#@\s]+(?:[/?][^#\s]*)?$/);
const Email = z.string().regex(/^[^\s@<>"(),;:]{1,64}@[A-Za-z0-9.-]{1,253}$/);

const Common = {
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES),
  categories: z.array(z.enum(NOTIFICATION_CATEGORIES)).max(NOTIFICATION_CATEGORIES.length),
  language: z.enum(NOTIFICATION_CHANNEL_LANGUAGES),
};

/**
 * Create or update a channel. Omitted credentials keep the stored ones on update; a create
 * without a required credential (ntfy topic, Telegram bot token, webhook URL) is refused.
 */
export const NotificationChannelInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ntfy"),
    ...Common,
    server: HttpUrl,
    topic: z
      .string()
      .regex(/^[\w-]{1,64}$/)
      .optional(),
    token: Secret.optional(),
    clearToken: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("telegram"),
    ...Common,
    chatId: z.string().regex(/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/),
    botToken: z
      .string()
      .regex(/^\d{3,20}:[A-Za-z0-9_-]{20,64}$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("email"),
    ...Common,
    host: z
      .string()
      .regex(/^(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$|^\[[0-9A-Fa-f:.]{2,45}\]$/),
    port: z.number().int().min(1).max(65535),
    security: z.enum(EMAIL_SECURITY),
    username: z
      .string()
      .max(254)
      .refine((value) => !/[\r\n\0]/.test(value)),
    password: Secret.optional(),
    clearPassword: z.boolean().optional(),
    from: Email,
    to: z.array(Email).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal("webhook"),
    ...Common,
    format: z.enum(WEBHOOK_FORMATS),
    url: HttpUrl.optional(),
    token: Secret.optional(),
    clearToken: z.boolean().optional(),
  }),
]);
export type NotificationChannelInput = z.infer<typeof NotificationChannelInputSchema>;
