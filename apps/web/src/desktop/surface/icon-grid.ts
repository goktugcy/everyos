import type { IconSize } from "@everyos/shared";
import type { Point, Rect } from "@everyos/window-manager";

export interface Cell {
  col: number;
  row: number;
}

export interface GridMetrics {
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
}

const CELL: Record<IconSize, { width: number; height: number }> = {
  small: { width: 84, height: 92 },
  medium: { width: 96, height: 106 },
  large: { width: 112, height: 124 },
};
const PADDING = 12;

export function gridMetrics(iconSize: IconSize, work: Rect): GridMetrics {
  const cell = CELL[iconSize];
  return {
    originX: work.x + PADDING,
    originY: work.y + PADDING,
    cellWidth: cell.width,
    cellHeight: cell.height,
    columns: Math.max(1, Math.floor((work.width - PADDING * 2) / cell.width)),
    rows: Math.max(1, Math.floor((work.height - PADDING * 2) / cell.height)),
  };
}

export const cellKey = (cell: Cell) => `${cell.col}:${cell.row}`;

export function cellRect(cell: Cell, metrics: GridMetrics): Rect {
  return {
    x: metrics.originX + cell.col * metrics.cellWidth,
    y: metrics.originY + cell.row * metrics.cellHeight,
    width: metrics.cellWidth,
    height: metrics.cellHeight,
  };
}

/** Grid cell under a point, clamped to the grid. */
export function cellAt(point: Point, metrics: GridMetrics): Cell {
  return {
    col: Math.min(
      metrics.columns - 1,
      Math.max(0, Math.floor((point.x - metrics.originX) / metrics.cellWidth)),
    ),
    row: Math.min(
      metrics.rows - 1,
      Math.max(0, Math.floor((point.y - metrics.originY) / metrics.cellHeight)),
    ),
  };
}

/**
 * First free cell in column-major order: top-left first, or top-right first
 * (where macOS puts the Desktop folder's items) when `fromRight` is set.
 */
export function firstFreeCell(
  occupied: ReadonlySet<string>,
  metrics: GridMetrics,
  fromRight = false,
): Cell {
  for (let index = 0; index < metrics.columns; index++) {
    const col = fromRight ? metrics.columns - 1 - index : index;
    for (let row = 0; row < metrics.rows; row++) {
      if (!occupied.has(cellKey({ col, row }))) return { col, row };
    }
  }
  // Grid is full: stack on the last cell rather than losing the icon.
  return { col: fromRight ? 0 : metrics.columns - 1, row: metrics.rows - 1 };
}

/** Anything with a stored cell: shortcuts, and entries of the Desktop folder. */
export interface Placeable {
  id: string;
  cell: Cell | null;
}

/**
 * Display positions for the icons of one desktop. Stored cells are kept when
 * they fit the current grid and are free; anything else (new items, items
 * pushed off-screen by a smaller display, collisions) gets the next free
 * cell. Stored preferences are not modified, so a larger display later shows
 * the user's original arrangement again.
 */
export function placeItems<T extends Placeable>(
  items: readonly T[],
  metrics: GridMetrics,
  fromRight: (item: T) => boolean = () => false,
): Map<string, Cell> {
  const placed = new Map<string, Cell>();
  const occupied = new Set<string>();
  const unplaced: T[] = [];
  for (const item of items) {
    const cell = item.cell;
    if (
      cell &&
      cell.col < metrics.columns &&
      cell.row < metrics.rows &&
      !occupied.has(cellKey(cell))
    ) {
      placed.set(item.id, cell);
      occupied.add(cellKey(cell));
    } else {
      unplaced.push(item);
    }
  }
  for (const item of unplaced) {
    const cell = firstFreeCell(occupied, metrics, fromRight(item));
    placed.set(item.id, cell);
    occupied.add(cellKey(cell));
  }
  return placed;
}
