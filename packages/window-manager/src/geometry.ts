import type { SnapZone, WindowLayout } from "@everyos/shared";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Browser viewport plus the space reserved by the menu bar and the dock. */
export interface Viewport extends Size {
  insets: Insets;
}

/** Height of the window title bar; it must always stay reachable. */
export const TITLE_BAR_HEIGHT = 40;
/** Horizontal part of a window that must remain on screen. */
export const MIN_VISIBLE_WIDTH = 96;
/** Distance from a screen edge that triggers snapping while dragging. */
export const SNAP_THRESHOLD = 12;
/** Corner region (along an edge) that snaps to a quarter instead of a half. */
export const SNAP_CORNER = 64;
const CASCADE_STEP = 28;
const WINDOW_MARGIN = 24;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function workArea(viewport: Viewport): Rect {
  const { insets } = viewport;
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(1, viewport.width - insets.left - insets.right),
    height: Math.max(1, viewport.height - insets.top - insets.bottom),
  };
}

export function snapRect(zone: SnapZone, work: Rect): Rect {
  const halfWidth = Math.round(work.width / 2);
  const halfHeight = Math.round(work.height / 2);
  const left = { x: work.x, width: halfWidth };
  const right = { x: work.x + halfWidth, width: work.width - halfWidth };
  const top = { y: work.y, height: halfHeight };
  const bottom = { y: work.y + halfHeight, height: work.height - halfHeight };
  switch (zone) {
    case "left":
      return { ...left, y: work.y, height: work.height };
    case "right":
      return { ...right, y: work.y, height: work.height };
    case "top-left":
      return { ...left, ...top };
    case "top-right":
      return { ...right, ...top };
    case "bottom-left":
      return { ...left, ...bottom };
    case "bottom-right":
      return { ...right, ...bottom };
  }
}

/** The on-screen rectangle of a window for its current layout. */
export function layoutRect(layout: WindowLayout, bounds: Rect, viewport: Viewport): Rect {
  switch (layout) {
    case "floating":
      return bounds;
    case "maximized":
      return workArea(viewport);
    case "fullscreen":
      return { x: 0, y: 0, width: viewport.width, height: viewport.height };
    case "left":
    case "right":
    case "top-left":
    case "top-right":
    case "bottom-left":
    case "bottom-right":
      return snapRect(layout, workArea(viewport));
  }
}

/**
 * Keeps a floating window usable: its size fits the work area and its title
 * bar can always be grabbed, whatever happened to the display.
 */
export function clampBounds(bounds: Rect, viewport: Viewport, minSize: Size): Rect {
  const work = workArea(viewport);
  const width = clamp(bounds.width, Math.min(minSize.width, work.width), work.width);
  const height = clamp(bounds.height, Math.min(minSize.height, work.height), work.height);
  const visible = Math.min(MIN_VISIBLE_WIDTH, width);
  return {
    width,
    height,
    x: clamp(bounds.x, work.x - width + visible, work.x + work.width - visible),
    y: clamp(bounds.y, work.y, work.y + work.height - TITLE_BAR_HEIGHT),
  };
}

/** Maps bounds proportionally from one viewport size to another. */
export function scaleBounds(bounds: Rect, from: Size, to: Size): Rect {
  if (from.width === to.width && from.height === to.height) return bounds;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return {
    x: Math.round(bounds.x * sx),
    y: Math.round(bounds.y * sy),
    width: Math.round(bounds.width * sx),
    height: Math.round(bounds.height * sy),
  };
}

/** Snap target for a pointer position while dragging a window, if any. */
export function detectSnapZone(pointer: Point, viewport: Viewport): WindowLayout | null {
  const work = workArea(viewport);
  const nearLeft = pointer.x <= work.x + SNAP_THRESHOLD;
  const nearRight = pointer.x >= work.x + work.width - SNAP_THRESHOLD;
  const nearTop = pointer.y <= work.y + SNAP_THRESHOLD;
  const inTopCorner = pointer.y <= work.y + SNAP_CORNER;
  const inBottomCorner = pointer.y >= work.y + work.height - SNAP_CORNER;
  if (nearLeft) return inTopCorner ? "top-left" : inBottomCorner ? "bottom-left" : "left";
  if (nearRight) return inTopCorner ? "top-right" : inBottomCorner ? "bottom-right" : "right";
  if (nearTop) return "maximized";
  return null;
}

/** Default size for a new window: requested size, shrunk to fit with a margin. */
export function initialSize(requested: Size, minSize: Size, viewport: Viewport): Size {
  const work = workArea(viewport);
  return {
    width: clamp(
      requested.width,
      Math.min(minSize.width, work.width),
      work.width - WINDOW_MARGIN * 2,
    ),
    height: clamp(
      requested.height,
      Math.min(minSize.height, work.height),
      work.height - WINDOW_MARGIN * 2,
    ),
  };
}

/** Centers the first window and cascades following ones. */
export function cascadePosition(existing: Rect[], size: Size, viewport: Viewport): Point {
  const work = workArea(viewport);
  const centered = {
    x: Math.round(work.x + (work.width - size.width) / 2),
    y: Math.round(work.y + Math.max(0, (work.height - size.height) / 3)),
  };
  let position = centered;
  for (let i = 0; i < 20; i++) {
    const taken = existing.some(
      (rect) => Math.abs(rect.x - position.x) < 8 && Math.abs(rect.y - position.y) < 8,
    );
    if (!taken) break;
    position = { x: position.x + CASCADE_STEP, y: position.y + CASCADE_STEP };
    if (
      position.x + size.width > work.x + work.width ||
      position.y + size.height > work.y + work.height
    ) {
      position = { x: work.x + WINDOW_MARGIN + i * 8, y: work.y + WINDOW_MARGIN + i * 8 };
    }
  }
  return position;
}

/** Rectangles for tiling `count` windows over the work area. */
export function tileRects(count: number, work: Rect, mode: "columns" | "grid"): Rect[] {
  if (count <= 0) return [];
  const columns = mode === "columns" ? count : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const width = Math.floor(work.width / columns);
  const height = Math.floor(work.height / rows);
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const isLastInRow = column === columns - 1 || index === count - 1;
    return {
      x: work.x + column * width,
      y: work.y + row * height,
      width: isLastInRow ? work.x + work.width - (work.x + column * width) : width,
      height: row === rows - 1 ? work.y + work.height - (work.y + row * height) : height,
    };
  });
}
