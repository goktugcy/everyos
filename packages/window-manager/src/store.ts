import type { PersistedWindow, WindowLayout, WindowSession } from "@everyos/shared";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  cascadePosition,
  clampBounds,
  initialSize,
  layoutRect,
  scaleBounds,
  tileRects,
  workArea,
  type Rect,
  type Size,
  type Viewport,
} from "./geometry.ts";

export interface WindowSpec {
  appId: string;
  title: string;
  defaultSize: Size;
  minSize: Size;
  /** "single": focus the existing window of this app instead of opening another. */
  instancing: "single" | "multiple";
}

export interface OpenOptions {
  appState?: unknown;
  desktopId?: string;
  /** Force a new instance even for single-instance apps. */
  newInstance?: boolean;
}

export interface WindowState {
  id: string;
  appId: string;
  desktopId: string;
  title: string;
  /** Floating geometry; restored when leaving maximized/snapped/fullscreen. */
  bounds: Rect;
  layout: WindowLayout;
  minimized: boolean;
  z: number;
  minSize: Size;
  appState?: unknown;
}

export interface WindowManagerState {
  windows: Record<string, WindowState>;
  focusedId: string | null;
  activeDesktopId: string;
  viewport: Viewport;
  topZ: number;
}

export interface WindowManagerActions {
  open(spec: WindowSpec, options?: OpenOptions): string;
  close(id: string): void;
  focus(id: string): void;
  minimize(id: string): void;
  restore(id: string): void;
  toggleMaximize(id: string): void;
  toggleFullscreen(id: string): void;
  setLayout(id: string, layout: WindowLayout): void;
  /** Sets floating bounds (used at the end of a drag or resize); clamped to the viewport. */
  setBounds(id: string, bounds: Rect): void;
  setTitle(id: string, title: string): void;
  setAppState(id: string, appState: unknown): void;
  setViewport(viewport: Viewport): void;
  switchDesktop(desktopId: string): void;
  moveToDesktop(id: string, desktopId: string): void;
  /** Moves every window of a removed desktop to another one. */
  mergeDesktop(fromDesktopId: string, intoDesktopId: string): void;
  cycle(direction: 1 | -1): void;
  tile(mode: "columns" | "grid"): void;
  minimizeAll(): void;
  hydrate(session: WindowSession, resolveSpec: (appId: string) => WindowSpec | null): void;
  serialize(): WindowSession;
}

export type WindowManagerStore = StoreApi<WindowManagerState & WindowManagerActions>;

export interface WindowManagerOptions {
  viewport: Viewport;
  desktopId: string;
  createId?: () => string;
}

let idCounter = 0;
const defaultId = () => `w${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Non-minimized windows on the active desktop, topmost first. */
export function visibleWindows(state: WindowManagerState): WindowState[] {
  return Object.values(state.windows)
    .filter((window) => window.desktopId === state.activeDesktopId && !window.minimized)
    .sort((a, b) => b.z - a.z);
}

/** The rectangle a window currently occupies on screen. */
export function effectiveRect(window: WindowState, viewport: Viewport): Rect {
  return layoutRect(window.layout, window.bounds, viewport);
}

function topmostOn(
  windows: Record<string, WindowState>,
  desktopId: string,
  except?: string,
): string | null {
  let best: WindowState | null = null;
  for (const window of Object.values(windows)) {
    if (window.id === except || window.desktopId !== desktopId || window.minimized) continue;
    if (!best || window.z > best.z) best = window;
  }
  return best?.id ?? null;
}

export function createWindowManager(options: WindowManagerOptions): WindowManagerStore {
  const createId = options.createId ?? defaultId;

  return createStore<WindowManagerState & WindowManagerActions>()((set, get) => {
    const update = (id: string, patch: Partial<WindowState>) =>
      set((state) => {
        const window = state.windows[id];
        if (!window) return state;
        return { windows: { ...state.windows, [id]: { ...window, ...patch } } };
      });

    const raise = (id: string) =>
      set((state) => {
        const window = state.windows[id];
        if (!window) return state;
        const z = state.topZ + 1;
        return {
          topZ: z,
          focusedId: id,
          activeDesktopId: window.desktopId,
          windows: { ...state.windows, [id]: { ...window, minimized: false, z } },
        };
      });

    return {
      windows: {},
      focusedId: null,
      activeDesktopId: options.desktopId,
      viewport: options.viewport,
      topZ: 0,

      open(spec, openOptions = {}) {
        const state = get();
        if (spec.instancing === "single" && !openOptions.newInstance) {
          const existing = Object.values(state.windows).find(
            (window) => window.appId === spec.appId,
          );
          if (existing) {
            if (openOptions.appState !== undefined)
              update(existing.id, { appState: openOptions.appState });
            raise(existing.id);
            return existing.id;
          }
        }
        const desktopId = openOptions.desktopId ?? state.activeDesktopId;
        const size = initialSize(spec.defaultSize, spec.minSize, state.viewport);
        const others = Object.values(state.windows)
          .filter((window) => window.desktopId === desktopId)
          .map((window) => window.bounds);
        const position = cascadePosition(others, size, state.viewport);
        const id = createId();
        const window: WindowState = {
          id,
          appId: spec.appId,
          desktopId,
          title: spec.title,
          bounds: clampBounds({ ...position, ...size }, state.viewport, spec.minSize),
          layout: "floating",
          minimized: false,
          z: state.topZ + 1,
          minSize: spec.minSize,
          ...(openOptions.appState !== undefined ? { appState: openOptions.appState } : {}),
        };
        set({
          windows: { ...state.windows, [id]: window },
          topZ: window.z,
          focusedId: id,
          activeDesktopId: desktopId,
        });
        return id;
      },

      close(id) {
        set((state) => {
          if (!state.windows[id]) return state;
          const { [id]: closed, ...windows } = state.windows;
          const focusedId =
            state.focusedId === id ? topmostOn(windows, closed!.desktopId) : state.focusedId;
          return { windows, focusedId };
        });
      },

      focus(id) {
        if (get().windows[id]) raise(id);
      },

      minimize(id) {
        set((state) => {
          const window = state.windows[id];
          if (!window || window.minimized) return state;
          const windows = { ...state.windows, [id]: { ...window, minimized: true } };
          const focusedId =
            state.focusedId === id ? topmostOn(windows, window.desktopId) : state.focusedId;
          return { windows, focusedId };
        });
      },

      restore(id) {
        if (get().windows[id]) raise(id);
      },

      toggleMaximize(id) {
        const window = get().windows[id];
        if (!window) return;
        update(id, { layout: window.layout === "maximized" ? "floating" : "maximized" });
        raise(id);
      },

      toggleFullscreen(id) {
        const window = get().windows[id];
        if (!window) return;
        update(id, { layout: window.layout === "fullscreen" ? "floating" : "fullscreen" });
        raise(id);
      },

      setLayout(id, layout) {
        if (!get().windows[id]) return;
        update(id, { layout });
        raise(id);
      },

      setBounds(id, bounds) {
        const state = get();
        const window = state.windows[id];
        if (!window) return;
        update(id, {
          bounds: clampBounds(bounds, state.viewport, window.minSize),
          layout: "floating",
        });
      },

      setTitle(id, title) {
        update(id, { title: title.slice(0, 120) });
      },

      setAppState(id, appState) {
        update(id, { appState });
      },

      setViewport(viewport) {
        set((state) => {
          const windows: Record<string, WindowState> = {};
          for (const window of Object.values(state.windows)) {
            const scaled = scaleBounds(window.bounds, state.viewport, viewport);
            windows[window.id] = {
              ...window,
              bounds: clampBounds(scaled, viewport, window.minSize),
            };
          }
          return { viewport, windows };
        });
      },

      switchDesktop(desktopId) {
        set((state) => ({
          activeDesktopId: desktopId,
          focusedId: topmostOn(state.windows, desktopId),
        }));
      },

      moveToDesktop(id, desktopId) {
        set((state) => {
          const window = state.windows[id];
          if (!window) return state;
          const windows = { ...state.windows, [id]: { ...window, desktopId } };
          return {
            windows,
            focusedId:
              state.focusedId === id ? topmostOn(windows, state.activeDesktopId) : state.focusedId,
          };
        });
      },

      mergeDesktop(fromDesktopId, intoDesktopId) {
        set((state) => {
          const windows: Record<string, WindowState> = {};
          for (const window of Object.values(state.windows)) {
            windows[window.id] =
              window.desktopId === fromDesktopId ? { ...window, desktopId: intoDesktopId } : window;
          }
          const activeDesktopId =
            state.activeDesktopId === fromDesktopId ? intoDesktopId : state.activeDesktopId;
          return { windows, activeDesktopId, focusedId: topmostOn(windows, activeDesktopId) };
        });
      },

      cycle(direction) {
        const state = get();
        const order = visibleWindows(state);
        if (order.length < 2) return;
        // Bring the bottom-most window to the front (forward) or send the focused one to the back.
        if (direction === 1) {
          raise(order[order.length - 1]!.id);
        } else {
          const [current] = order;
          const lowest = Math.min(...order.map((window) => window.z));
          update(current!.id, { z: lowest - 1 });
          set({ focusedId: order[1]!.id });
        }
      },

      tile(mode) {
        const state = get();
        const targets = visibleWindows(state).reverse();
        const rects = tileRects(targets.length, workArea(state.viewport), mode);
        set({
          windows: {
            ...state.windows,
            ...Object.fromEntries(
              targets.map((window, index) => [
                window.id,
                {
                  ...window,
                  layout: "floating" as const,
                  bounds: clampBounds(rects[index]!, state.viewport, window.minSize),
                },
              ]),
            ),
          },
        });
      },

      minimizeAll() {
        set((state) => {
          const windows: Record<string, WindowState> = {};
          for (const window of Object.values(state.windows)) {
            windows[window.id] =
              window.desktopId === state.activeDesktopId ? { ...window, minimized: true } : window;
          }
          return { windows, focusedId: null };
        });
      },

      hydrate(session, resolveSpec) {
        const viewport = get().viewport;
        const windows: Record<string, WindowState> = {};
        let topZ = 0;
        for (const saved of session.windows) {
          const spec = resolveSpec(saved.appId);
          if (!spec) continue;
          const scaled = scaleBounds(saved.bounds, session.viewport, viewport);
          windows[saved.id] = {
            id: saved.id,
            appId: saved.appId,
            desktopId: saved.desktopId,
            title: saved.title || spec.title,
            bounds: clampBounds(scaled, viewport, spec.minSize),
            layout: saved.layout,
            minimized: saved.minimized,
            z: saved.z,
            minSize: spec.minSize,
            ...(saved.appState !== undefined ? { appState: saved.appState } : {}),
          };
          topZ = Math.max(topZ, saved.z);
        }
        set({
          windows,
          topZ,
          activeDesktopId: session.activeDesktopId,
          focusedId: topmostOn(windows, session.activeDesktopId),
        });
      },

      serialize() {
        const state = get();
        // Persist the stacking order as ranks (1..n) so z never grows without bound.
        const ranked = Object.values(state.windows).sort((a, b) => a.z - b.z);
        const windows: PersistedWindow[] = ranked.map((window, index) => ({
          id: window.id,
          appId: window.appId,
          desktopId: window.desktopId,
          title: window.title,
          bounds: window.bounds,
          layout: window.layout,
          minimized: window.minimized,
          z: index + 1,
          ...(window.appState !== undefined ? { appState: window.appState } : {}),
        }));
        return {
          version: 1,
          viewport: { width: state.viewport.width, height: state.viewport.height },
          activeDesktopId: state.activeDesktopId,
          windows,
        };
      },
    };
  });
}
