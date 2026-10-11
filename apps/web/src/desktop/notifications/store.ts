import {
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationCounts,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationView,
} from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../lib/api.ts";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { usePreferences } from "../state/preferences-store.ts";

interface NotificationState {
  unread: NotificationCounts;
  /** Pop-ups currently shown (newest last, at most three). */
  toasts: NotificationView[];
  /** Bumps on every change; open lists refetch on it. */
  revision: number;
}

export const useNotifications = create<NotificationState>()(() => ({
  unread: {},
  toasts: [],
  revision: 0,
}));

const MAX_TOASTS = 3;
const rank = (severity: NotificationView["severity"]) => NOTIFICATION_SEVERITIES.indexOf(severity);

/** Unread notifications outside muted categories (the menu bar badge). */
export function unreadTotal(
  unread: NotificationCounts,
  muted: readonly NotificationCategory[],
): number {
  return Object.entries(unread).reduce(
    (sum, [category, count]) =>
      muted.includes(category as NotificationCategory) ? sum : sum + (count ?? 0),
    0,
  );
}

/** Whether a new notification should pop up for this user. */
export function shouldToast(
  notification: NotificationView,
  preferences: NotificationPreferences,
): boolean {
  return (
    preferences.toasts &&
    !notification.read &&
    !preferences.mutedCategories.includes(notification.category) &&
    rank(notification.severity) >= rank(preferences.toastMinSeverity)
  );
}

function onEvent(event: NotificationEvent): void {
  useNotifications.setState((state) => {
    const latest = event.latest;
    const toasts =
      latest && shouldToast(latest, usePreferences.getState().notifications)
        ? [...state.toasts.filter((t) => t.id !== latest.id), latest].slice(-MAX_TOASTS)
        : state.toasts;
    return { unread: event.unread, toasts, revision: state.revision + 1 };
  });
}

let subscribers = 0;
let unsubscribe: (() => void) | null = null;

/** Keeps the tab subscribed to notification events while the caller is mounted. */
export function useNotificationStream(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    subscribers++;
    if (subscribers === 1) {
      unsubscribe = subscribeTopic("notifications", {
        // A reconnect may have missed changes: refetch open lists.
        ready: () => useNotifications.setState((s) => ({ revision: s.revision + 1 })),
        events: { notifications: (data) => onEvent(data as NotificationEvent) },
      });
    }
    return () => {
      subscribers--;
      if (subscribers === 0) {
        unsubscribe?.();
        unsubscribe = null;
        useNotifications.setState({ unread: {}, toasts: [] });
      }
    };
  }, [enabled]);
}

export function closeToast(id: string): void {
  useNotifications.setState((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
}

type Target = { ids: string[] } | { all: true };

async function change(path: "read" | "unread" | "dismiss", target: Target): Promise<void> {
  const { unread } = await api<{ unread: NotificationCounts }>(`/notifications/${path}`, {
    method: "POST",
    body: target,
  });
  useNotifications.setState((state) => ({ unread, revision: state.revision + 1 }));
}

export const notificationActions = {
  markRead: (target: Target) => change("read", target),
  markUnread: (ids: string[]) => change("unread", { ids }),
  dismiss: (target: Target) => change("dismiss", target),
};
