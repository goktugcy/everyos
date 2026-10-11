import type { NotificationView } from "@otuken/shared";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../../stores/session-store.ts";
import { notificationAction, notificationText } from "./content.ts";
import { openNotification, SeverityIcon } from "./center.tsx";
import { closeToast, useNotifications } from "./store.ts";

/** Critical pop-ups stay until closed; others disappear after eight seconds. */
const TOAST_MS = 8_000;

function Toast({ notification }: { notification: NotificationView }) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { title, body } = notificationText(t, notification);
  const action = notificationAction(notification.kind, permissions);
  useEffect(() => {
    if (notification.severity === "critical") return;
    const timer = setTimeout(() => closeToast(notification.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [notification.id, notification.severity]);
  return (
    <li
      className="glass-strong otk-enter pointer-events-auto flex w-80 gap-3 rounded-otk-lg p-3 text-fg"
      role={notification.severity === "critical" ? "alert" : "status"}
      data-testid="notification-toast"
    >
      <SeverityIcon severity={notification.severity} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold leading-snug">{title}</p>
        <p className="text-xs leading-relaxed text-fg-muted">{body}</p>
        {action ? (
          <button
            type="button"
            className="mt-1 self-start text-xs font-medium text-accent hover:underline"
            onClick={() => {
              openNotification(notification, permissions);
              closeToast(notification.id);
            }}
          >
            {t("notifications.open")}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-hover/10 hover:text-fg"
        aria-label={t("common.close")}
        onClick={() => closeToast(notification.id)}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

/** New notifications worth interrupting for (filtered by the user's preferences). */
export function NotificationToasts() {
  const { t } = useTranslation();
  const toasts = useNotifications((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <ol
      className="pointer-events-none fixed right-3 top-12 z-[76] flex flex-col gap-2"
      aria-label={t("notifications.title")}
    >
      {toasts.map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </ol>
  );
}
