import { useEffect } from "react";
import { useSessionStore } from "../../stores/session-store.ts";
import { usePreferences } from "../state/preferences-store.ts";

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/** Locks the session after the configured period without user interaction. */
export function useAutoLock(): void {
  const minutes = usePreferences((state) => state.security.autoLockMinutes);
  const locked = useSessionStore((state) => state.locked);

  useEffect(() => {
    if (minutes === 0 || locked) return;
    let last = Date.now();
    const onActivity = () => {
      last = Date.now();
    };
    for (const name of ACTIVITY_EVENTS)
      window.addEventListener(name, onActivity, { passive: true });
    // Coarse check; activity events only update a timestamp (no timers per event).
    const timer = setInterval(() => {
      if (Date.now() - last >= minutes * 60_000) void useSessionStore.getState().lock();
    }, 15_000);
    return () => {
      clearInterval(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
    };
  }, [minutes, locked]);
}
