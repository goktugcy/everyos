import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { hostname } from "node:os";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import { resources } from "@everyos/i18n";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import {
  DEFAULT_NTFY_SERVER,
  MAX_NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNEL_BURST,
  NOTIFICATION_SEVERITIES,
  type EmailSecurity,
  type NotificationCategory,
  type NotificationChannelKind,
  type NotificationChannelLanguage,
  type NotificationChannelView,
  type NotificationParams,
  type NotificationSeverity,
  type WebhookFormat,
} from "@everyos/shared";
import type { NotificationChannelInput } from "@everyos/shared/schemas";
import nodemailer from "nodemailer";
import { ApiError } from "../../http/errors.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  IntegrationHttpError,
  joinUrl,
  requestText,
  resolveIntegrationAddress,
  type HttpOptions,
} from "../integrations/http.ts";
import type { NotificationProvider, StoredNotification } from "./notification-service.ts";

/** What is sealed per channel: every value that could reach or impersonate it. */
type Config =
  | { kind: "ntfy"; server: string; topic: string; token: string }
  | { kind: "telegram"; chatId: string; botToken: string }
  | {
      kind: "email";
      host: string;
      port: number;
      security: EmailSecurity;
      username: string;
      password: string;
      from: string;
      to: string[];
    }
  | { kind: "webhook"; format: WebhookFormat; url: string; token: string };

interface Row {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: number;
  min_severity: NotificationSeverity;
  categories: string;
  language: NotificationChannelLanguage;
  sealed_config: string;
  last_delivery_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** A rendered notification as channels send it. */
export interface ChannelMessage {
  title: string;
  body: string;
  severity: NotificationSeverity;
  host: string;
  notification: Pick<
    StoredNotification,
    "id" | "kind" | "category" | "params" | "count" | "createdAt"
  >;
}

/** The part of nodemailer EveryOS uses; tests replace it. */
export type SmtpTransportFactory = (options: {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  auth?: { user: string; pass: string };
  tls: { servername?: string; minVersion: "TLSv1.2" };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}) => { sendMail(mail: Record<string, unknown>): Promise<unknown> };

const BURST_WINDOW_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const rank = (severity: NotificationSeverity) => NOTIFICATION_SEVERITIES.indexOf(severity);
const ICONS: Record<NotificationSeverity, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  critical: "🚨",
};
const NTFY: Record<NotificationSeverity, { priority: number; tag: string }> = {
  info: { priority: 3, tag: "information_source" },
  success: { priority: 3, tag: "white_check_mark" },
  warning: { priority: 4, tag: "warning" },
  critical: { priority: 5, tag: "rotating_light" },
};

/** A dotted path in the locale messages, if it is a string. */
function message(language: NotificationChannelLanguage, path: string): string | null {
  let value: unknown = resources[language];
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : null;
}

/** The same title and body the notification center shows, in the channel's language. */
export function renderNotification(
  notification: Pick<StoredNotification, "kind" | "params">,
  language: NotificationChannelLanguage,
): { title: string; body: string } {
  const params: NotificationParams = { ...notification.params };
  if (typeof params.action === "string")
    params.action = message(language, `appStore.actions.${params.action}`) ?? params.action;
  if (typeof params.power === "string")
    params.power = message(language, `hostPower.progress.${params.power}`) ?? params.power;
  if (params.mounted === "yes" || params.mounted === "no")
    params.mounted = message(language, `disks.attachedState.${params.mounted}`) ?? "";
  if (params.unsafe === "yes" || params.unsafe === "no")
    params.unsafe = message(language, `disks.detachedState.${params.unsafe}`) ?? "";
  if (typeof params.reason === "string") {
    const code = params.reason.split(":")[0]!;
    params.reason =
      message(language, `notifications.reasons.${params.reason}`) ??
      message(language, `backups.jobErrors.${code}`) ??
      params.reason;
  }
  const fill = (text: string | null) =>
    (text ?? notification.kind).replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
      String(params[key] ?? ""),
    );
  return {
    title: fill(message(language, `notifications.kinds.${notification.kind}.title`)),
    body: fill(message(language, `notifications.kinds.${notification.kind}.body`)),
  };
}

/** A short, credential-free reason for the last failure. */
function failure(error: unknown): string {
  if (error instanceof IntegrationHttpError)
    return error.kind === "status" ? `http-status-${error.status ?? 0}` : `http-${error.kind}`;
  const code = (error as { code?: unknown; responseCode?: unknown } | null)?.code;
  if (code === "EAUTH") return "smtp-auth";
  if (code === "ETIMEDOUT") return "smtp-timeout";
  if (code === "EENVELOPE" || code === "EMESSAGE") return "smtp-rejected";
  if (code === "ECONNECTION" || code === "ESOCKET" || code === "EDNS") return "smtp-connection";
  if (code === "ETLS") return "smtp-tls";
  return "failed";
}

const slack = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * External notification channels: ntfy, Telegram, e-mail and webhooks. Administrators manage
 * them; delivery is a notification provider, so a failing channel never affects the in-app center.
 */
export class NotificationChannelService {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #audit: AuditLog;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #resolve: HttpOptions["resolve"];
  readonly #smtp: SmtpTransportFactory;
  readonly #host: string;
  readonly #telegram: string;
  readonly #sent = new Map<string, number[]>();

  constructor(deps: {
    db: Database;
    secrets: SecretBox;
    audit: AuditLog;
    logger: Logger;
    now: () => number;
    resolve?: HttpOptions["resolve"];
    smtp?: SmtpTransportFactory;
    host?: string;
    /** Test hook: the Telegram Bot API origin. */
    telegram?: string;
  }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#audit = deps.audit;
    this.#logger = deps.logger.child({ component: "notification-channels" });
    this.#now = deps.now;
    this.#resolve = deps.resolve;
    this.#smtp = deps.smtp ?? ((options) => nodemailer.createTransport(options));
    this.#host = (deps.host ?? hostname()).slice(0, 64);
    this.#telegram = deps.telegram ?? "https://api.telegram.org";
  }

  list(): NotificationChannelView[] {
    return this.#db
      .all<Row>("SELECT * FROM notification_channels ORDER BY created_at, id")
      .map((row) => this.#view(row));
  }

  create(input: NotificationChannelInput, actor: Actor): NotificationChannelView {
    if (
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notification_channels")!.n >=
      MAX_NOTIFICATION_CHANNELS
    )
      throw new ApiError(409, "CONFLICT", "Channel limit reached");
    const id = randomUUID();
    const config = this.#config(input, null);
    const now = this.#now();
    this.#db.run(
      `INSERT INTO notification_channels(id, kind, name, enabled, min_severity, categories, language, sealed_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.name,
      input.enabled ? 1 : 0,
      input.minSeverity,
      JSON.stringify(input.categories),
      input.language,
      this.#seal(id, config),
      now,
      now,
    );
    this.#event("create", actor, id, input.kind);
    return this.get(id);
  }

  get(id: string): NotificationChannelView {
    return this.#view(this.#row(id));
  }

  update(id: string, input: NotificationChannelInput, actor: Actor): NotificationChannelView {
    const row = this.#row(id);
    if (row.kind !== input.kind)
      throw new ApiError(422, "VALIDATION_FAILED", "A channel's kind cannot change");
    const config = this.#config(input, this.#open(row));
    this.#db.run(
      `UPDATE notification_channels SET name = ?, enabled = ?, min_severity = ?, categories = ?, language = ?, sealed_config = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      input.name,
      input.enabled ? 1 : 0,
      input.minSeverity,
      JSON.stringify(input.categories),
      input.language,
      this.#seal(id, config),
      this.#now(),
      id,
    );
    this.#event("update", actor, id, input.kind);
    return this.get(id);
  }

  remove(id: string, actor: Actor): void {
    const row = this.#row(id);
    this.#db.run("DELETE FROM notification_channels WHERE id = ?", id);
    this.#sent.delete(id);
    this.#event("delete", actor, id, row.kind);
  }

  /** Sends a test message now, ignoring filters and the burst limit; failures are reported. */
  async test(id: string, actor: Actor): Promise<void> {
    const row = this.#row(id);
    const language = row.language;
    const title = message(language, "notifications.channels.testTitle") ?? "EveryOS";
    const body = message(language, "notifications.channels.testBody") ?? "";
    try {
      await this.#send(row, {
        title,
        body: body.replace("{{host}}", this.#host),
        severity: "info",
        host: this.#host,
        notification: {
          id: "test",
          kind: "app-succeeded",
          category: "system",
          params: {},
          count: 1,
          createdAt: this.#now(),
        },
      });
      this.#record(id, null);
      this.#event("test", actor, id, row.kind);
    } catch (error) {
      const reason = failure(error);
      this.#record(id, reason);
      this.#event("test", actor, id, row.kind, reason);
      throw new ApiError(502, "CHANNEL_DELIVERY_FAILED", "The channel did not accept the message", {
        details: { reason },
      });
    }
  }

  /** The notification provider delivering to every matching enabled channel. */
  provider(): NotificationProvider {
    return { id: "channels", deliver: (notification) => this.deliver(notification) };
  }

  async deliver(notification: StoredNotification): Promise<void> {
    // Notifications for one person stay in the app.
    if (notification.userId !== null) return;
    const rows = this.#db
      .all<Row>("SELECT * FROM notification_channels WHERE enabled = 1")
      .filter((row) => {
        const categories = JSON.parse(row.categories) as NotificationCategory[];
        return (
          rank(notification.severity) >= rank(row.min_severity) &&
          (categories.length === 0 || categories.includes(notification.category))
        );
      });
    await Promise.all(
      rows.map(async (row) => {
        if (!this.#allow(row.id)) {
          this.#logger.warn("Notification channel burst limit reached", { channel: row.id });
          return;
        }
        const text = renderNotification(notification, row.language);
        try {
          await this.#send(row, {
            ...text,
            severity: notification.severity,
            host: this.#host,
            notification,
          });
          this.#record(row.id, null);
        } catch (error) {
          const reason = failure(error);
          this.#record(row.id, reason);
          this.#logger.warn("Notification channel delivery failed", {
            channel: row.id,
            kind: row.kind,
            reason,
          });
        }
      }),
    );
  }

  #allow(id: string): boolean {
    const now = this.#now();
    const recent = (this.#sent.get(id) ?? []).filter((at) => now - at < BURST_WINDOW_MS);
    if (recent.length >= NOTIFICATION_CHANNEL_BURST) {
      this.#sent.set(id, recent);
      return false;
    }
    recent.push(now);
    this.#sent.set(id, recent);
    return true;
  }

  async #send(row: Row, msg: ChannelMessage): Promise<void> {
    const config = this.#open(row);
    const http = (headers: Record<string, string> = {}): HttpOptions => ({
      method: "POST",
      timeoutMs: HTTP_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      headers: { "User-Agent": "EveryOS-Notifications/1", ...headers },
      ...(this.#resolve ? { resolve: this.#resolve } : {}),
    });
    const heading = `${ICONS[msg.severity]} ${msg.title}`;
    switch (config.kind) {
      case "ntfy":
        // JSON publishing keeps non-ASCII titles intact (headers cannot carry them).
        await requestText(joinUrl(config.server, "/"), {
          ...http(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          body: {
            topic: config.topic,
            title: msg.title,
            message: `${msg.body}\n— EveryOS · ${msg.host}`,
            priority: NTFY[msg.severity].priority,
            tags: [NTFY[msg.severity].tag],
          },
        });
        return;
      case "telegram":
        // Plain text: no parse mode, so notification text can never become markup.
        await requestText(`${this.#telegram}/bot${config.botToken}/sendMessage`, {
          ...http(),
          body: {
            chat_id: config.chatId,
            text: `${heading}\n${msg.body}\n\n— EveryOS · ${msg.host}`,
            disable_web_page_preview: true,
          },
        });
        return;
      case "webhook":
        await requestText(config.url, {
          ...http(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          body:
            config.format === "discord"
              ? {
                  username: "EveryOS",
                  content: `**${heading}**\n${msg.body}\n— ${msg.host}`.slice(0, 2000),
                  // Text such as "@everyone" never pings anyone.
                  allowed_mentions: { parse: [] },
                }
              : config.format === "slack"
                ? { text: `*${slack(heading)}*\n${slack(msg.body)}\n— ${slack(msg.host)}` }
                : {
                    source: "everyos",
                    host: msg.host,
                    id: msg.notification.id,
                    kind: msg.notification.kind,
                    category: msg.notification.category,
                    severity: msg.severity,
                    title: msg.title,
                    body: msg.body,
                    params: msg.notification.params,
                    count: msg.notification.count,
                    createdAt: msg.notification.createdAt,
                  },
        });
        return;
      case "email": {
        // Pinned like other outbound requests, while TLS still checks the configured name.
        const host = config.host.replace(/^\[|\]$/g, "");
        const address = await resolveIntegrationAddress(
          new URL(`smtp://${config.host}`),
          this.#resolve,
        );
        const transport = this.#smtp({
          host: address.address,
          port: config.port,
          secure: config.security === "tls",
          requireTLS: config.security === "starttls",
          ignoreTLS: config.security === "none",
          ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
          // RFC 6066 has no IP server names; certificates are then checked against the address.
          tls: isIP(host) ? { minVersion: "TLSv1.2" } : { servername: host, minVersion: "TLSv1.2" },
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        });
        await transport.sendMail({
          from: { name: `EveryOS · ${msg.host}`, address: config.from },
          to: config.to,
          subject: `${heading}`.replace(/[\r\n]+/g, " ").slice(0, 200),
          text: `${msg.body}\n\n— EveryOS · ${msg.host}`,
        });
        return;
      }
    }
  }

  #config(input: NotificationChannelInput, old: Config | null): Config {
    const previous = old?.kind === input.kind ? old : null;
    switch (input.kind) {
      case "ntfy": {
        const prior = previous as Extract<Config, { kind: "ntfy" }> | null;
        const topic = input.topic ?? prior?.topic;
        if (!topic) throw new ApiError(422, "VALIDATION_FAILED", "An ntfy topic is required");
        return {
          kind: "ntfy",
          server: input.server || DEFAULT_NTFY_SERVER,
          topic,
          token: input.clearToken ? "" : (input.token ?? prior?.token ?? ""),
        };
      }
      case "telegram": {
        const prior = previous as Extract<Config, { kind: "telegram" }> | null;
        const botToken = input.botToken ?? prior?.botToken;
        if (!botToken) throw new ApiError(422, "VALIDATION_FAILED", "A bot token is required");
        return { kind: "telegram", chatId: input.chatId, botToken };
      }
      case "email": {
        const prior = previous as Extract<Config, { kind: "email" }> | null;
        const password = input.clearPassword ? "" : (input.password ?? prior?.password ?? "");
        // Credentials never cross an unencrypted connection.
        if (input.security === "none" && (input.username || password))
          throw new ApiError(422, "VALIDATION_FAILED", "Sign-in needs an encrypted connection");
        return {
          kind: "email",
          host: input.host,
          port: input.port,
          security: input.security,
          username: input.username,
          password,
          from: input.from,
          to: [...new Set(input.to)],
        };
      }
      case "webhook": {
        const prior = previous as Extract<Config, { kind: "webhook" }> | null;
        const url = input.url ?? prior?.url;
        if (!url) throw new ApiError(422, "VALIDATION_FAILED", "A webhook address is required");
        return {
          kind: "webhook",
          format: input.format,
          url,
          token: input.clearToken ? "" : (input.token ?? prior?.token ?? ""),
        };
      }
    }
  }

  #row(id: string): Row {
    const row = this.#db.get<Row>("SELECT * FROM notification_channels WHERE id = ?", id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Notification channel not found");
    return row;
  }

  #seal(id: string, config: Config): string {
    return this.#secrets.seal(JSON.stringify(config), `notify-channel:${id}:config:v1`);
  }

  #open(row: Row): Config {
    return JSON.parse(
      this.#secrets.open(row.sealed_config, `notify-channel:${row.id}:config:v1`),
    ) as Config;
  }

  #record(id: string, error: string | null): void {
    this.#db.run(
      error
        ? "UPDATE notification_channels SET last_error = ? WHERE id = ?"
        : "UPDATE notification_channels SET last_error = ?, last_delivery_at = ? WHERE id = ?",
      ...(error ? [error, id] : [null, this.#now(), id]),
    );
  }

  #view(row: Row): NotificationChannelView {
    const config = this.#open(row);
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      minSeverity: row.min_severity,
      categories: JSON.parse(row.categories) as NotificationCategory[],
      language: row.language,
      settings:
        config.kind === "ntfy"
          ? {
              kind: "ntfy",
              server: config.server,
              // The topic works like a password on public servers; only a hint is shown.
              topicHint: `${config.topic.slice(0, 3)}…`,
            }
          : config.kind === "telegram"
            ? { kind: "telegram", chatId: config.chatId }
            : config.kind === "email"
              ? {
                  kind: "email",
                  host: config.host,
                  port: config.port,
                  security: config.security,
                  username: config.username,
                  from: config.from,
                  to: config.to,
                }
              : { kind: "webhook", format: config.format, origin: new URL(config.url).origin },
      hasSecret:
        config.kind === "email"
          ? Boolean(config.password)
          : config.kind === "telegram"
            ? true
            : Boolean(config.token),
      lastDeliveryAt: row.last_delivery_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #event(
    action: string,
    actor: Actor,
    id: string,
    kind: NotificationChannelKind,
    reason?: string,
  ): void {
    this.#audit.record({
      action: `notifications.channel.${action}`,
      target: id,
      outcome: reason ? "failure" : "success",
      ...(actor.kind === "user"
        ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
        : {}),
      details: { kind, ...(reason ? { reason } : {}) },
    });
  }
}
