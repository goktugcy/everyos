import type { DockPreferences } from "@otuken/shared";
import {
  createWindowManager,
  type Insets,
  type Viewport,
  type WindowManagerActions,
  type WindowManagerState,
} from "@otuken/window-manager";
import { useStore } from "zustand";

export const MENUBAR_HEIGHT = 36;
const DOCK_MARGIN = 10;

/** Space a visible (non auto-hiding) dock takes from the work area. */
export function dockThickness(dock: DockPreferences): number {
  if (dock.autoHide) return 0;
  const padding = dock.style === "floating" ? 16 + DOCK_MARGIN * 2 : 12;
  return dock.iconSize + padding;
}

export function computeInsets(dock: DockPreferences): Insets {
  const thickness = dockThickness(dock);
  return {
    top: MENUBAR_HEIGHT,
    right: dock.position === "right" ? thickness : 0,
    bottom: dock.position === "bottom" ? thickness : 0,
    left: dock.position === "left" ? thickness : 0,
  };
}

export function measureViewport(insets: Insets): Viewport {
  return { width: window.innerWidth, height: window.innerHeight, insets };
}

/** The single window manager instance of this browser tab. */
export const windowManager = createWindowManager({
  viewport: measureViewport({ top: MENUBAR_HEIGHT, right: 0, bottom: 0, left: 0 }),
  desktopId: "d1",
});

export function useWindowManager<T>(
  selector: (state: WindowManagerState & WindowManagerActions) => T,
): T {
  return useStore(windowManager, selector);
}

export const wm = (): WindowManagerState & WindowManagerActions => windowManager.getState();
