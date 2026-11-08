import { useEffect } from "react";
import type { NotificationEvent } from "@everyos/shared";
import { i18next } from "../../app/i18n.ts";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { loadDesktopApps } from "./store.ts";

/** Keep launchers/runtime URLs current, including after a missed automatic-update event. */
export function useDesktopAppRefresh(
  enabled: boolean,
  sessionId: string | undefined,
  canReadNotifications = false,
): void {
  useEffect(() => {
    if (!enabled || !sessionId) return;
    const controller = new AbortController();
    let loading = false;
    let again = false;
    const refresh = async () => {
      if (controller.signal.aborted || document.visibilityState !== "visible") return;
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      try {
        await loadDesktopApps(i18next.language, controller.signal);
      } catch {
        /* Keep the last verified list; events, visibility and polling retry it. */
      } finally {
        loading = false;
        if (again) {
          again = false;
          void refresh();
        }
      }
    };
    const tick = () => {
      void refresh();
    };
    const unsubscribe = canReadNotifications
      ? subscribeTopic("notifications", {
          ready: tick,
          events: {
            notifications: (data) => {
              if ((data as NotificationEvent).latest?.kind === "desktop-app-updated") tick();
            },
          },
        })
      : () => undefined;
    const timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    tick();
    return () => {
      controller.abort();
      clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, sessionId, canReadNotifications]);
}
