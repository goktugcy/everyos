import {
  detectSnapZone,
  effectiveRect,
  layoutRect,
  type Rect,
  type Size,
  type Viewport,
} from "@everyos/window-manager";
import type { PointerEvent as ReactPointerEvent } from "react";
import { wm } from "../state/window-store.ts";
import { setSnapPreview } from "./snap-preview.tsx";

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const DRAG_THRESHOLD = 3;

/** Writes a rectangle straight to the frame element (no React render). */
export function paintFrame(frame: HTMLElement, rect: Rect): void {
  frame.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
  frame.style.width = `${rect.width}px`;
  frame.style.height = `${rect.height}px`;
}

/** Re-applies the store's geometry, discarding any in-flight imperative styles. */
export function syncFrame(frame: HTMLElement, id: string): void {
  const state = wm();
  const window = state.windows[id];
  if (window) paintFrame(frame, effectiveRect(window, state.viewport));
}

function track(
  event: ReactPointerEvent,
  onMove: (dx: number, dy: number, pointer: PointerEvent) => void,
  onEnd: (moved: boolean) => void,
): void {
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  let frame = 0;
  let last: PointerEvent | null = null;

  const move = (pointer: PointerEvent) => {
    const dx = pointer.clientX - startX;
    const dy = pointer.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    moved = true;
    last = pointer;
    if (frame) return;
    // Coalesce pointer events to one paint per animation frame.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (last) onMove(last.clientX - startX, last.clientY - startY, last);
    });
  };
  const end = () => {
    cancelAnimationFrame(frame);
    if (last && moved) onMove(last.clientX - startX, last.clientY - startY, last);
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    onEnd(moved);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

/** Title-bar dragging with edge snapping and "un-maximize on drag". */
export function startWindowDrag(event: ReactPointerEvent, id: string, frame: HTMLElement): void {
  if (event.button !== 0) return;
  const state = wm();
  const window = state.windows[id];
  if (!window || window.layout === "fullscreen") return;
  const viewport: Viewport = state.viewport;
  const start = effectiveRect(window, viewport);
  let base: Rect = start;
  let current: Rect = start;
  let zone: ReturnType<typeof detectSnapZone> = null;
  let detached = window.layout === "floating";

  track(
    event,
    (dx, dy, pointer) => {
      if (!detached) {
        // Leaving a maximized/snapped layout: restore the floating size under the pointer.
        detached = true;
        const ratio = (event.clientX - start.x) / start.width;
        base = {
          x: event.clientX - window.bounds.width * ratio,
          y: start.y,
          width: window.bounds.width,
          height: window.bounds.height,
        };
      }
      current = { ...base, x: base.x + dx, y: Math.max(viewport.insets.top, base.y + dy) };
      paintFrame(frame, current);
      zone = detectSnapZone({ x: pointer.clientX, y: pointer.clientY }, viewport);
      setSnapPreview(zone ? layoutRect(zone, current, viewport) : null);
    },
    (moved) => {
      setSnapPreview(null);
      if (!moved) return;
      wm().setBounds(id, current);
      if (zone) wm().setLayout(id, zone);
      syncFrame(frame, id);
    },
  );
}

/** Edge/corner resizing honouring the minimum size and the work area. */
export function startWindowResize(
  event: ReactPointerEvent,
  id: string,
  frame: HTMLElement,
  edge: ResizeEdge,
): void {
  if (event.button !== 0) return;
  event.stopPropagation();
  const state = wm();
  const window = state.windows[id];
  if (!window) return;
  const viewport = state.viewport;
  const start = effectiveRect(window, viewport);
  const min: Size = window.minSize;
  let current = start;

  track(
    event,
    (dx, dy) => {
      let { x, y, width, height } = start;
      if (edge.includes("e")) width = Math.max(min.width, start.width + dx);
      if (edge.includes("s")) height = Math.max(min.height, start.height + dy);
      if (edge.includes("w")) {
        width = Math.max(min.width, start.width - dx);
        x = start.x + start.width - width;
      }
      if (edge.includes("n")) {
        const top = Math.max(viewport.insets.top, start.y + dy);
        height = Math.max(min.height, start.y + start.height - top);
        y = start.y + start.height - height;
      }
      current = { x, y, width, height };
      paintFrame(frame, current);
    },
    (moved) => {
      if (moved) wm().setBounds(id, current);
      syncFrame(frame, id);
    },
  );
}
