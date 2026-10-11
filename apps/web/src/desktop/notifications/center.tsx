import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationList,
  type NotificationSeverity,
  type NotificationView,
} from "@everyos/shared";
import {
  Bell,
  BellOff,
  CheckCheck,
  CircleCheck,
  Info,
  OctagonAlert,
  Settings2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatRelative } from "../../lib/format.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { menubarButton } from "../menubar/menubar-button.ts";
import { desktop } from "../state/controller.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { notificationAction, notificationText } from "./content.ts";
import {
  notificationActions,
  unreadTotal,
  useNotificationStream,
  useNotifications,
} from "./store.ts";

export function SeverityIcon({
  severity,
  className,
}: {
  severity: NotificationSeverity;
  className?: string;
}) {
  const Icon =
    severity === "critical"
      ? OctagonAlert
      : severity === "warning"
        ? TriangleAlert
        : severity === "success"
          ? CircleCheck
          : Info;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        severity === "critical" && "text-danger",
        severity === "warning" && "text-warning",
        severity === "success" && "text-success",
        severity === "info" && "text-accent",
        className,
      )}
    />
  );
}

/** Opens the app a notification refers to (marking it read). */
export function openNotification(
  notification: NotificationView,
  permissions: Parameters<typeof notificationAction>[1],
): boolean {
  const action = notificationAction(notification.kind, permissions);
  if (!notification.read)
    void notificationActions.markRead({ ids: [notification.id] }).catch(() => undefined);
  if (!action) return false;
  desktop.openApp(action.appId, action.appState ? { appState: action.appState } : {});
  return true;
}

function NotificationItem({
  notification,
  muted,
}: {
  notification: NotificationView;
  muted: boolean;
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const { title, body } = notificationText(t, notification);
  const action = notificationAction(notification.kind, permissions);
  return (
    <li
      className={cn(
        "group/item relative flex gap-3 rounded-everyos-md px-3 py-2.5",
        notification.read ? "opacity-80" : "bg-[rgb(var(--everyos-accent)/0.08)]",
        muted && "opacity-60",
      )}
      data-testid="notification"
      data-kind={notification.kind}
    >
      <SeverityIcon severity={notification.severity} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          className="text-left text-sm font-semibold leading-snug outline-none hover:underline focus-visible:underline disabled:no-underline"
          onClick={() => openNotification(notification, permissions)}
        >
          {!notification.read ? (
            <span className="sr-only">{t("notifications.unread")}: </span>
          ) : null}
          {title}
        </button>
        <p className="text-xs leading-relaxed text-fg-muted">{body}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-[0.7rem] text-fg-subtle">
          <time dateTime={new Date(notification.updatedAt).toISOString()}>
            {formatRelative(notification.updatedAt, i18n.language)}
          </time>
          {notification.count > 1 ? (
            <span>{t("notifications.repeated", { count: notification.count })}</span>
          ) : null}
          {notification.resolvedAt ? (
            <span className="font-medium text-success">{t("notifications.resolved")}</span>
          ) : null}
          {action ? <span>{t(`notifications.categories.${notification.category}`)}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1">
        {!notification.read ? (
          <span className="mt-1.5 size-2 rounded-full bg-accent" aria-hidden />
        ) : null}
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md text-fg-subtle opacity-0 outline-none hover:bg-hover/10 hover:text-fg focus-visible:opacity-100 group-hover/item:opacity-100"
          aria-label={t("notifications.dismiss")}
          title={t("notifications.dismiss")}
          onClick={() => void notificationActions.dismiss({ ids: [notification.id] })}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </li>
  );
}

const selectClass =
  "glass-inset h-8 rounded-everyos-sm px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent [&>option]:bg-[rgb(var(--everyos-surface))]";

function CenterBody() {
  const { t } = useTranslation();
  const revision = useNotifications((state) => state.revision);
  const muted = usePreferences((state) => state.notifications.mutedCategories);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [severity, setSeverity] = useState<NotificationSeverity | "">("");
  const [category, setCategory] = useState<NotificationCategory | "">("");
  const [grouped, setGrouped] = useState(false);
  const [pages, setPages] = useState<NotificationView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (unreadOnly) params.set("unread", "true");
    if (severity) params.set("severity", severity);
    if (category) params.set("category", category);
    return params;
  }, [unreadOnly, severity, category]);

  useEffect(() => {
    const controller = new AbortController();
    api<NotificationList>(`/notifications?${query}`, { signal: controller.signal })
      .then((page) => {
        setPages(page.notifications);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, revision]);

  const loadMore = async () => {
    if (!cursor) return;
    const next = new URLSearchParams(query);
    next.set("before", cursor);
    const page = await api<NotificationList>(`/notifications?${next}`);
    setPages((current) => [...current, ...page.notifications]);
    setCursor(page.nextCursor);
  };

  const groups = grouped
    ? NOTIFICATION_CATEGORIES.map((c) => ({
        category: c,
        items: pages.filter((n) => n.category === c),
      })).filter((g) => g.items.length > 0)
    : [{ category: null, items: pages }];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 pb-3">
        <div role="radiogroup" aria-label={t("notifications.show")} className="flex gap-1">
          {([false, true] as const).map((value) => (
            <button
              key={String(value)}
              type="button"
              role="radio"
              aria-checked={unreadOnly === value}
              onClick={() => setUnreadOnly(value)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium",
                unreadOnly === value
                  ? "bg-[rgb(var(--everyos-accent)/0.24)] text-fg"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {value ? t("notifications.unreadOnly") : t("notifications.all")}
            </button>
          ))}
        </div>
        <select
          aria-label={t("notifications.severity")}
          className={selectClass}
          value={severity}
          onChange={(event) => setSeverity(event.target.value as NotificationSeverity | "")}
        >
          <option value="">{t("notifications.allSeverities")}</option>
          {[...NOTIFICATION_SEVERITIES].reverse().map((value) => (
            <option key={value} value={value}>
              {t(`notifications.severities.${value}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t("notifications.category")}
          className={selectClass}
          value={category}
          onChange={(event) => setCategory(event.target.value as NotificationCategory | "")}
        >
          <option value="">{t("notifications.allCategories")}</option>
          {NOTIFICATION_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {t(`notifications.categories.${value}`)}
            </option>
          ))}
        </select>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(event) => setGrouped(event.target.checked)}
            className="accent-[rgb(var(--everyos-accent))]"
          />
          {t("notifications.group")}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-live="polite">
        {error ? (
          <p className="p-4 text-sm text-danger">{errorMessage(t, error)}</p>
        ) : loading ? null : pages.length === 0 ? (
          <p className="flex flex-col items-center gap-2 p-8 text-center text-sm text-fg-muted">
            <BellOff className="size-6" aria-hidden />
            {t("notifications.empty")}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.category ?? "all"}
              aria-label={
                group.category ? t(`notifications.categories.${group.category}`) : undefined
              }
            >
              {group.category ? (
                <h3 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  {t(`notifications.categories.${group.category}`)}
                </h3>
              ) : null}
              <ul className="flex flex-col gap-1">
                {group.items.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    muted={muted.includes(notification.category)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        {cursor ? (
          <button
            type="button"
            className="mx-auto mt-2 block rounded-everyos-sm px-3 py-1.5 text-xs text-accent hover:bg-hover/8"
            onClick={() => void loadMore()}
          >
            {t("notifications.older")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Menu bar bell with the unread badge; opens the notification center. */
export function NotificationBell() {
  const { t } = useTranslation();
  const permitted = usePermissions().includes("notifications:read");
  useNotificationStream(permitted);
  const unread = useNotifications((state) => state.unread);
  const muted = usePreferences((state) => state.notifications.mutedCategories);
  const [open, setOpen] = useState(false);
  if (!permitted) return null;
  const total = unreadTotal(unread, muted);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The center shows everything; pop-ups would only repeat it.
        if (next) useNotifications.setState({ toasts: [] });
      }}
    >
      <Popover.Trigger
        className={cn(menubarButton, "relative")}
        aria-label={
          total > 0 ? t("notifications.titleUnread", { count: total }) : t("notifications.title")
        }
        title={t("notifications.title")}
        data-testid="notification-bell"
      >
        <Bell className="size-4" aria-hidden />
        {total > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[0.6rem] font-bold leading-none text-white"
            aria-hidden
          >
            {total > 9 ? "9+" : total}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="glass-strong everyos-enter z-[8000] flex max-h-[min(75vh,640px)] w-[min(94vw,26rem)] flex-col rounded-everyos-lg text-fg"
          aria-label={t("notifications.title")}
          data-testid="notification-center"
        >
          <div className="flex items-center gap-1 px-4 pb-2 pt-3">
            <h2 className="flex-1 text-sm font-semibold">{t("notifications.title")}</h2>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-hover/10 hover:text-fg"
              aria-label={t("notifications.markAllRead")}
              title={t("notifications.markAllRead")}
              onClick={() => void notificationActions.markRead({ all: true })}
            >
              <CheckCheck className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-hover/10 hover:text-fg"
              aria-label={t("notifications.settings")}
              title={t("notifications.settings")}
              onClick={() => {
                setOpen(false);
                desktop.openSettings("notifications");
              }}
            >
              <Settings2 className="size-4" aria-hidden />
            </button>
          </div>
          {open ? <CenterBody /> : null}
          <div className="flex justify-end border-t border-line px-4 py-2">
            <button
              type="button"
              className="rounded-everyos-sm px-2 py-1 text-xs text-fg-muted hover:bg-hover/8 hover:text-fg"
              onClick={() => void notificationActions.dismiss({ all: true })}
            >
              {t("notifications.clearAll")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
