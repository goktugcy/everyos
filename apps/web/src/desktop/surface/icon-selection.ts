import type { Point, Rect } from "@everyos/window-manager";
import { cellKey, type Cell, type GridMetrics } from "./icon-grid.ts";

export interface SelectionModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Shift extends from the anchor; Ctrl/Command toggles an individual icon. */
export function selectIcon(
  current: ReadonlySet<string>,
  id: string,
  order: readonly string[],
  anchor: string | null,
  modifiers: SelectionModifiers,
): Set<string> {
  const additive = modifiers.ctrlKey || modifiers.metaKey;
  if (modifiers.shiftKey && anchor !== null && order.includes(anchor) && order.includes(id)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    return new Set([
      ...(additive ? current : []),
      ...order.slice(Math.min(a, b), Math.max(a, b) + 1),
    ]);
  }
  if (!additive) return new Set([id]);
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectionRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function iconsInRect(rect: Rect, bounds: ReadonlyMap<string, Rect>): Set<string> {
  return new Set(
    [...bounds]
      .filter(
        ([, icon]) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x < icon.x + icon.width &&
          rect.x + rect.width > icon.x &&
          rect.y < icon.y + icon.height &&
          rect.y + rect.height > icon.y,
      )
      .map(([id]) => id),
  );
}

/** Translate a group without clipping it or colliding with stationary icons. */
export function moveSelection(
  ids: ReadonlySet<string>,
  anchor: string,
  target: Cell,
  placed: ReadonlyMap<string, Cell>,
  metrics: GridMetrics,
): Map<string, Cell> | null {
  const from = placed.get(anchor);
  if (!from) return null;
  const moving = [...placed].filter(([id]) => ids.has(id));
  if (!moving.length) return null;
  const dx = Math.min(
    metrics.columns - 1 - Math.max(...moving.map(([, cell]) => cell.col)),
    Math.max(-Math.min(...moving.map(([, cell]) => cell.col)), target.col - from.col),
  );
  const dy = Math.min(
    metrics.rows - 1 - Math.max(...moving.map(([, cell]) => cell.row)),
    Math.max(-Math.min(...moving.map(([, cell]) => cell.row)), target.row - from.row),
  );
  const stationary = new Set(
    [...placed].filter(([id]) => !ids.has(id)).map(([, cell]) => cellKey(cell)),
  );
  const next = new Map(
    moving.map(([id, cell]) => [id, { col: cell.col + dx, row: cell.row + dy }]),
  );
  return [...next.values()].some((cell) => stationary.has(cellKey(cell))) ? null : next;
}
