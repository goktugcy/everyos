import {
  DEFAULT_NTFY_SERVER,
  EMAIL_SECURITY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_CHANNEL_LANGUAGES,
  NOTIFICATION_SEVERITIES,
  WEBHOOK_FORMATS,
  type EmailSecurity,
  type NotificationCategory,
  type NotificationChannelKind,
  type NotificationChannelLanguage,
  type NotificationChannelView,
  type NotificationSeverity,
  type WebhookFormat,
} from "@everyos/shared";
import type { TFunction } from "i18next";
import { Bell, Mail, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatRelative } from "../../../lib/format.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError } from "../system/parts.tsx";
import { SettingsGroup } from "./group.tsx";

const ICONS: Record<NotificationChannelKind, ReactNode> = {
  ntfy: <Bell className="size-4" aria-hidden />,
  telegram: <Send className="size-4" aria-hidden />,
  email: <Mail className="size-4" aria-hidden />,
  webhook: <Webhook className="size-4" aria-hidden />,
};

/** A stored failure reason in words. */
function reasonText(t: TFunction, reason: string): string {
  const status = /^http-status-(\d+)$/.exec(reason);
  if (status) return t("notifications.channels.httpStatus", { status: status[1] });
  return t(`notifications.channels.errors.${reason as "failed"}`, {
    defaultValue: t("notifications.channels.errors.failed"),
  });
}

/** Administrators' external channels: list, add, edit, test and delete. */
export function NotificationChannelsGroup() {
  const { t, i18n } = useTranslation();
  const [revision, setRevision] = useState(0);
  const list = useApiResource<{ channels: NotificationChannelView[] }>(
    "/notification-channels",
    null,
    revision,
  );
  const [editing, setEditing] = useState<NotificationChannelView | "new" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const reload = () => setRevision((n) => n + 1);
  const test = async (channel: NotificationChannelView) => {
    setTesting(channel.id);
    setNotice(null);
    try {
      await api(`/notification-channels/${channel.id}/test`, { method: "POST", body: {} });
      setNotice({ tone: "success", text: t("notifications.channels.testSent") });
    } catch (error) {
      setNotice({ tone: "danger", text: errorMessage(t, error) });
    } finally {
      setTesting(null);
      reload();
    }
  };
  const remove = async (channel: NotificationChannelView) => {
    const ok = await requestConfirm({
      title: t("notifications.channels.remove"),
      body: t("notifications.channels.removeConfirm", { name: channel.name }),
      confirmLabel: t("common.delete"),
    });
    if (!ok) return;
    try {
      await api(`/notification-channels/${channel.id}`, {
        method: "DELETE",
        body: { confirmId: channel.id },
      });
    } catch (error) {
      setNotice({ tone: "danger", text: errorMessage(t, error) });
    }
    reload();
  };
  return (
    <SettingsGroup
      title={t("notifications.channels.title")}
      description={t("notifications.channels.hint")}
    >
      <div className="flex flex-col gap-2" data-testid="notification-channels">
        {list.data?.channels.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("notifications.channels.empty")}</p>
        ) : null}
        {list.data?.channels.map((channel) => (
          <div
            key={channel.id}
            className="glass-inset flex flex-wrap items-center gap-3 rounded-everyos-md p-3"
            data-testid="notification-channel"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-hover/10">
              {ICONS[channel.settings.kind]}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{channel.name}</span>
              <span className="truncate text-xs text-fg-muted">
                {t(`notifications.channels.kinds.${channel.settings.kind}`)} ·{" "}
                {t(
                  channel.enabled
                    ? "notifications.channels.enabled"
                    : "notifications.channels.disabled",
                )}{" "}
                ·{" "}
                {channel.lastDeliveryAt
                  ? t("notifications.channels.lastDelivery", {
                      time: formatRelative(channel.lastDeliveryAt, i18n.language),
                    })
                  : t("notifications.channels.neverDelivered")}
              </span>
              {channel.lastError ? (
                <span className="text-xs text-danger">
                  {t("notifications.channels.lastError", {
                    reason: reasonText(t, channel.lastError),
                  })}
                </span>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={testing === channel.id}
              onClick={() => void test(channel)}
            >
              <Send className="size-4" aria-hidden />
              {t("notifications.channels.test")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${t("notifications.channels.edit")}: ${channel.name}`}
              onClick={() => setEditing(channel)}
            >
              <Pencil className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${t("notifications.channels.remove")}: ${channel.name}`}
              onClick={() => void remove(channel)}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        <ResourceError error={list.error} />
        {notice ? (
          <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Alert>
        ) : null}
        <div>
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="size-4" aria-hidden />
            {t("notifications.channels.add")}
          </Button>
        </div>
      </div>
      {editing ? (
        <ChannelDialog
          channel={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </SettingsGroup>
  );
}

interface Form {
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  minSeverity: NotificationSeverity;
  categories: NotificationCategory[];
  language: NotificationChannelLanguage;
  server: string;
  topic: string;
  chatId: string;
  host: string;
  port: string;
  security: EmailSecurity;
  username: string;
  from: string;
  to: string;
  format: WebhookFormat;
  url: string;
  /** ntfy/webhook token, Telegram bot token or SMTP password; blank keeps the stored one. */
  secret: string;
  clearSecret: boolean;
}

function initial(channel: NotificationChannelView | null, language: string): Form {
  const settings = channel?.settings;
  return {
    kind: settings?.kind ?? "ntfy",
    name: channel?.name ?? "",
    enabled: channel?.enabled ?? true,
    minSeverity: channel?.minSeverity ?? "warning",
    categories: channel?.categories ?? [],
    language: channel?.language ?? (language === "en" ? "en" : "tr"),
    server: settings?.kind === "ntfy" ? settings.server : DEFAULT_NTFY_SERVER,
    topic: "",
    chatId: settings?.kind === "telegram" ? settings.chatId : "",
    host: settings?.kind === "email" ? settings.host : "",
    port: settings?.kind === "email" ? String(settings.port) : "587",
    security: settings?.kind === "email" ? settings.security : "starttls",
    username: settings?.kind === "email" ? settings.username : "",
    from: settings?.kind === "email" ? settings.from : "",
    to: settings?.kind === "email" ? settings.to.join(", ") : "",
    format: settings?.kind === "webhook" ? settings.format : "discord",
    url: "",
    secret: "",
    clearSecret: false,
  };
}

/** The request body for the channel's kind; blank optional credentials are left out. */
function body(form: Form) {
  const common = {
    kind: form.kind,
    name: form.name,
    enabled: form.enabled,
    minSeverity: form.minSeverity,
    categories: form.categories,
    language: form.language,
  };
  const secret = form.secret.trim();
  switch (form.kind) {
    case "ntfy":
      return {
        ...common,
        server: form.server.trim(),
        ...(form.topic.trim() ? { topic: form.topic.trim() } : {}),
        ...(secret ? { token: secret } : {}),
        ...(form.clearSecret ? { clearToken: true } : {}),
      };
    case "telegram":
      return { ...common, chatId: form.chatId.trim(), ...(secret ? { botToken: secret } : {}) };
    case "email":
      return {
        ...common,
        host: form.host.trim(),
        port: Number(form.port),
        security: form.security,
        username: form.username.trim(),
        from: form.from.trim(),
        to: form.to
          .split(",")
          .map((address) => address.trim())
          .filter(Boolean),
        ...(secret ? { password: secret } : {}),
        ...(form.clearSecret ? { clearPassword: true } : {}),
      };
    case "webhook":
      return {
        ...common,
        format: form.format,
        ...(form.url.trim() ? { url: form.url.trim() } : {}),
        ...(secret ? { token: secret } : {}),
        ...(form.clearSecret ? { clearToken: true } : {}),
      };
  }
}

function ChannelDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel: NotificationChannelView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState(() => initial(channel, i18n.language));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));
  const f = (key: string) => t(`notifications.channels.fields.${key as "name"}`);
  const stored = channel?.hasSecret ?? false;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(channel ? `/notification-channels/${channel.id}` : "/notification-channels", {
        method: channel ? "PUT" : "POST",
        body: body(form),
      });
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const secretField = (label: string, hint?: string, required = false) => (
    <>
      <Field
        label={label}
        type="password"
        autoComplete="off"
        value={form.secret}
        onChange={(event) => set({ secret: event.target.value })}
        hint={
          stored && channel?.settings.kind === form.kind ? t("notifications.channels.stored") : hint
        }
        required={required && !stored}
      />
      {stored && !required ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.clearSecret}
            onChange={(event) => set({ clearSecret: event.target.checked })}
          />
          {t("notifications.channels.clearSecret")}
        </label>
      ) : null}
    </>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(channel ? "notifications.channels.edit" : "notifications.channels.add")}
      className="w-[min(96vw,560px)]"
    >
      <form
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
        onSubmit={(event) => void submit(event)}
        data-testid="notification-channel-form"
      >
        {!channel ? (
          <div role="radiogroup" aria-label={f("kind")} className="grid gap-2 sm:grid-cols-2">
            {NOTIFICATION_CHANNEL_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={form.kind === kind}
                onClick={() => set({ kind, secret: "", clearSecret: false })}
                className={cn(
                  "glass-inset flex flex-col gap-1 rounded-everyos-md p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  form.kind === kind && "ring-2 ring-accent",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {ICONS[kind]}
                  {t(`notifications.channels.kinds.${kind}`)}
                </span>
                <span className="text-xs text-fg-muted">
                  {t(`notifications.channels.kindHints.${kind}`)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <Field
          label={f("name")}
          value={form.name}
          maxLength={64}
          required
          onChange={(event) => set({ name: event.target.value })}
        />
        {form.kind === "ntfy" ? (
          <>
            <Field
              label={f("server")}
              type="url"
              value={form.server}
              required
              onChange={(event) => set({ server: event.target.value })}
            />
            <Field
              label={f("topic")}
              value={form.topic}
              pattern="[A-Za-z0-9_\-]{1,64}"
              required={!channel}
              hint={
                channel?.settings.kind === "ntfy"
                  ? t("notifications.channels.stored")
                  : f("topicHint")
              }
              onChange={(event) => set({ topic: event.target.value })}
            />
            {secretField(f("token"))}
          </>
        ) : null}
        {form.kind === "telegram" ? (
          <>
            {secretField(f("botToken"), f("botTokenHint"), true)}
            <Field
              label={f("chatId")}
              value={form.chatId}
              required
              hint={f("chatIdHint")}
              onChange={(event) => set({ chatId: event.target.value })}
            />
          </>
        ) : null}
        {form.kind === "email" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
              <Field
                label={f("host")}
                value={form.host}
                required
                onChange={(event) => set({ host: event.target.value })}
              />
              <Field
                label={f("port")}
                type="number"
                min={1}
                max={65535}
                value={form.port}
                required
                onChange={(event) => set({ port: event.target.value })}
              />
            </div>
            <Select
              label={f("security")}
              value={form.security}
              options={EMAIL_SECURITY.map((value) => ({
                value,
                label: t(`notifications.channels.security.${value}`),
              }))}
              onChange={(security) => set({ security })}
            />
            <Field
              label={f("username")}
              value={form.username}
              autoComplete="off"
              onChange={(event) => set({ username: event.target.value })}
            />
            {secretField(f("password"))}
            <Field
              label={f("from")}
              type="email"
              value={form.from}
              required
              onChange={(event) => set({ from: event.target.value })}
            />
            <Field
              label={f("to")}
              value={form.to}
              required
              hint={f("toHint")}
              onChange={(event) => set({ to: event.target.value })}
            />
          </>
        ) : null}
        {form.kind === "webhook" ? (
          <>
            <Select
              label={f("format")}
              value={form.format}
              options={WEBHOOK_FORMATS.map((value) => ({
                value,
                label: t(`notifications.channels.formats.${value}`),
              }))}
              onChange={(format) => set({ format })}
            />
            <Field
              label={f("url")}
              type="url"
              value={form.url}
              required={!channel}
              hint={
                channel?.settings.kind === "webhook"
                  ? `${channel.settings.origin} · ${t("notifications.channels.stored")}`
                  : f("urlHint")
              }
              onChange={(event) => set({ url: event.target.value })}
            />
            {form.format === "json" ? secretField(f("bearer")) : null}
          </>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={f("minSeverity")}
            value={form.minSeverity}
            options={NOTIFICATION_SEVERITIES.map((value) => ({
              value,
              label: t(`notifications.minSeverity.${value}`),
            }))}
            onChange={(minSeverity) => set({ minSeverity })}
          />
          <Select
            label={f("language")}
            value={form.language}
            options={NOTIFICATION_CHANNEL_LANGUAGES.map((value) => ({
              value,
              label: t(`languages.${value}`),
            }))}
            onChange={(language) => set({ language })}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[0.8rem] font-medium text-fg-muted">
            {f("categories")}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {NOTIFICATION_CATEGORIES.map((category) => {
              const on = form.categories.includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({
                      categories: on
                        ? form.categories.filter((c) => c !== category)
                        : [...form.categories, category],
                    })
                  }
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    on ? "button-accent" : "bg-hover/8 text-fg-muted hover:text-fg",
                  )}
                >
                  {t(`notifications.categories.${category}`)}
                </button>
              );
            })}
          </div>
          {form.categories.length === 0 ? (
            <span className="text-xs text-fg-subtle">{f("allCategories")}</span>
          ) : null}
        </fieldset>
        <label className="flex items-center justify-between gap-3 text-sm">
          {t("notifications.channels.enabled")}
          <Toggle
            label={t("notifications.channels.enabled")}
            checked={form.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
          />
        </label>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
