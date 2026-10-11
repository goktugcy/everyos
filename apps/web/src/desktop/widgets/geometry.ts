import { WIDGET_CELL_PX, type WidgetInstance } from "@everyos/shared";
import { cellsOf, type DesktopGrid } from "@everyos/widget-sdk";

/** The desktop grid plus its top-left corner on screen. */
export type ScreenGrid = DesktopGrid & { originX: number; originY: number };

/** Gap between neighbouring widgets inside their grid cells. */
export const GAP = 8;
export const DRAG_THRESHOLD = 4;

export type Cell = { col: number; row: number };

/**
 * Where a widget is drawn. A narrower work area (window resize, sidebar
 * opened) shifts it inward without changing the saved layout.
 */
export function visibleCell(instance: WidgetInstance, grid: ScreenGrid): Cell {
  const { w, h } = cellsOf(instance);
  const position = instance.position ?? { col: 0, row: 0 };
  return {
    col: Math.max(0, Math.min(position.col, grid.columns - w)),
    row: Math.max(0, Math.min(position.row, grid.rows - h)),
  };
}

export function cellBox(cell: Cell, size: { w: number; h: number }, grid: ScreenGrid) {
  return {
    left: grid.originX + cell.col * WIDGET_CELL_PX + GAP / 2,
    top: grid.originY + cell.row * WIDGET_CELL_PX + GAP / 2,
    width: size.w * WIDGET_CELL_PX - GAP,
    height: size.h * WIDGET_CELL_PX - GAP,
  };
}

type Rect = Cell & { w: number; h: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

function insideGrid(rect: Rect, grid: ScreenGrid): boolean {
  return (
    rect.col >= 0 &&
    rect.row >= 0 &&
    rect.col + rect.w <= grid.columns &&
    rect.row + rect.h <= grid.rows
  );
}

/** Closest free cell to `from` (by grid distance), or null when nothing fits. */
function nearestFree(
  size: { w: number; h: number },
  from: Cell,
  taken: Rect[],
  grid: ScreenGrid,
): Cell | null {
  let best: { cell: Cell; distance: number } | null = null;
  for (let row = 0; row + size.h <= grid.rows; row++) {
    for (let col = 0; col + size.w <= grid.columns; col++) {
      const rect = { col, row, ...size };
      if (taken.some((other) => overlaps(rect, other))) continue;
      const distance = Math.abs(col - from.col) + Math.abs(row - from.row);
      if (!best || distance < best.distance) best = { cell: { col, row }, distance };
    }
  }
  return best?.cell ?? null;
}

/**
 * Where every visible desktop widget is drawn. Widgets that still fit keep
 * their place; the others move inward and, if that collides, to the nearest
 * free cell, so a narrower work area never stacks widgets on each other.
 */
export function effectiveCells(
  instances: readonly WidgetInstance[],
  grid: ScreenGrid,
): Map<string, Cell> {
  const fitsAsSaved = (instance: WidgetInstance) =>
    instance.position !== null && insideGrid({ ...instance.position, ...cellsOf(instance) }, grid);
  const ordered = [...instances].sort((a, b) => Number(fitsAsSaved(b)) - Number(fitsAsSaved(a)));
  const taken: Rect[] = [];
  const cells = new Map<string, Cell>();
  for (const instance of ordered) {
    const size = cellsOf(instance);
    let cell = visibleCell(instance, grid);
    if (taken.some((other) => overlaps({ ...cell, ...size }, other)))
      cell = nearestFree(size, cell, taken, grid) ?? cell;
    taken.push({ ...cell, ...size });
    cells.set(instance.id, cell);
  }
  return cells;
}
