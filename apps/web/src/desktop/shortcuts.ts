import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store.ts";
import { useLauncher } from "./launcher/launcher-store.ts";
import { desktop } from "./state/controller.ts";
import { wm } from "./state/window-store.ts";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * Global shortcuts. Ctrl+Alt is used for window management because browsers
 * reserve most Ctrl/Cmd and Alt combinations; keys are matched by physical
 * code so they work on Turkish Q/F and other layouts.
 */
export function useDesktopShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (useSessionStore.getState().locked) return;
      const mod = event.ctrlKey || event.metaKey;
      if (
        (mod && !event.altKey && event.code === "KeyK") ||
        (event.altKey && !mod && event.code === "Space")
      ) {
        event.preventDefault();
        useLauncher.getState().toggle();
        return;
      }
      if (event.altKey && !mod && event.code === "Backquote") {
        event.preventDefault();
        wm().cycle(event.shiftKey ? -1 : 1);
        return;
      }
      if (!(event.ctrlKey && event.altKey)) return;
      // Letter combinations may be AltGr characters while typing (Ctrl+Alt on Windows).
      if (isEditable(event.target) && event.code.startsWith("Key")) return;

      const state = wm();
      const focused = state.focusedId;
      const handled = (() => {
        switch (event.code) {
          case "ArrowLeft":
            if (focused) state.setLayout(focused, "left");
            return true;
          case "ArrowRight":
            if (focused) state.setLayout(focused, "right");
            return true;
          case "ArrowUp":
            if (focused) state.toggleMaximize(focused);
            return true;
          case "ArrowDown":
            if (focused) state.minimize(focused);
            return true;
          case "KeyW":
            if (focused) state.close(focused);
            return true;
          case "KeyT":
            state.tile("columns");
            return true;
          case "KeyL":
            void useSessionStore.getState().lock();
            return true;
          case "PageDown":
            desktop.switchDesktopBy(1);
            return true;
          case "PageUp":
            desktop.switchDesktopBy(-1);
            return true;
          default:
            return false;
        }
      })();
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
