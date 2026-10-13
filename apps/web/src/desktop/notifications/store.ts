import {
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationCounts,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationView,
  type NotificationList,
} from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../lib/api.ts";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";

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
const seenVersions = new Set<string>();
let seenSession: string | undefined;

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
  const candidate = event.latest;
  const repeatedVersion =
    candidate?.kind === "everyos-update-available" && seenVersions.has(candidate.id);
  if (candidate?.kind === "everyos-update-available") {
    if (seenVersions.size >= 128) seenVersions.delete(seenVersions.values().next().value!);
    seenVersions.add(candidate.id);
  }
  useNotifications.setState((state) => {
    const latest = repeatedVersion ? null : event.latest;
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
  const sessionId = useSessionStore((state) => state.session?.session.id);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    subscribers++;
    if (subscribers === 1) {
      if (seenSession !== sessionId) {
        seenVersions.clear();
        seenSession = sessionId;
      }
      const controller = new AbortController();
      let refreshing = false;
      const active = () => {
        const session = useSessionStore.getState();
        return (
          !controller.signal.aborted &&
          document.visibilityState === "visible" &&
          session.phase === "authenticated" &&
          !session.locked &&
          session.session?.session.id === sessionId
        );
      };
      // Recover version notices missed while hidden/disconnected, without re-alerting seen versions.
      const refresh = async () => {
        if (!active() || refreshing || document.visibilityState !== "visible") return;
        refreshing = true;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const revision = useNotifications.getState().revision;
            const page = await api<NotificationList & { unread: NotificationCounts }>(
              "/notifications?category=updates&unread=true&limit=200",
              { signal: controller.signal },
            );
            if (!active()) return;
            if (revision !== useNotifications.getState().revision) continue;
            useNotifications.setState({ unread: page.unread });
            for (const notice of page.notifications) {
              if (
                notice.kind === "everyos-update-available" &&
                !notice.read &&
                notice.resolvedAt === null &&
                !seenVersions.has(notice.id)
              )
                onEvent({ unread: page.unread, latest: notice });
            }
            return;
          }
        } catch {
          /* Event delivery and the next poll can recover a failed read. */
        } finally {
          refreshing = false;
        }
      };
      const onVisible = () => void refresh();
      const stopStream = subscribeTopic("notifications", {
        // A reconnect may have missed changes: refetch open lists.
        ready: () => {
          useNotifications.setState((s) => ({ revision: s.revision + 1 }));
          void refresh();
        },
        events: { notifications: (data) => onEvent(data as NotificationEvent) },
      });
      const timer = setInterval(onVisible, 30_000);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", onVisible);
      void refresh();
      unsubscribe = () => {
        controller.abort();
        stopStream();
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", onVisible);
      };
    }
    return () => {
      subscribers--;
      if (subscribers === 0) {
        unsubscribe?.();
        unsubscribe = null;
        useNotifications.setState({ unread: {}, toasts: [] });
      }
    };
  }, [enabled, sessionId]);
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
