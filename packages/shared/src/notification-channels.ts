import type { NotificationCategory, NotificationSeverity } from "./notifications.ts";

/*
 * External delivery channels for notifications (docs/notifications.md#external-channels).
 * Credentials and the URLs or topics that work like credentials are sealed on the server and
 * never returned; views carry only what an administrator needs to recognize a channel.
 */

export const NOTIFICATION_CHANNEL_KINDS = ["ntfy", "telegram", "email", "webhook"] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

export const WEBHOOK_FORMATS = ["discord", "slack", "json"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** `tls`: TLS from the first byte (465); `starttls`: upgraded plain connection (587). */
export const EMAIL_SECURITY = ["tls", "starttls", "none"] as const;
export type EmailSecurity = (typeof EMAIL_SECURITY)[number];

export const NOTIFICATION_CHANNEL_LANGUAGES = ["tr", "en"] as const;
export type NotificationChannelLanguage = (typeof NOTIFICATION_CHANNEL_LANGUAGES)[number];

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

/** Non-secret settings shown back to administrators. */
export type NotificationChannelSettings =
  | { kind: "ntfy"; server: string; topicHint: string }
  | { kind: "telegram"; chatId: string }
  | {
      kind: "email";
      host: string;
      port: number;
      security: EmailSecurity;
      username: string;
      from: string;
      to: string[];
    }
  | { kind: "webhook"; format: WebhookFormat; origin: string };

export interface NotificationChannelView {
  id: string;
  name: string;
  enabled: boolean;
  /** Notifications below this severity are not sent. */
  minSeverity: NotificationSeverity;
  /** Empty sends every category. */
  categories: NotificationCategory[];
  language: NotificationChannelLanguage;
  settings: NotificationChannelSettings;
  /** Whether an optional credential (ntfy access token, webhook bearer token, SMTP password) is stored. */
  hasSecret: boolean;
  lastDeliveryAt: number | null;
  /** The last failure's short, credential-free reason. */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** At most this many messages per channel within ten minutes; the rest is dropped and logged. */
export const NOTIFICATION_CHANNEL_BURST = 20;
export const MAX_NOTIFICATION_CHANNELS = 10;
