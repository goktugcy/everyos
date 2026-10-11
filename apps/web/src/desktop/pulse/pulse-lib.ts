import { MAX_SHELF_ITEMS, type ShelfItem } from "@everyos/shared";

/* ----------------------------- calendar ----------------------------- */

/** `YYYY-MM-DD` of a local date (the key the task calendar API uses). */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** First day of the week for a language: 0 = Sunday, 1 = Monday (Turkish and ISO). */
export function firstDayOfWeek(language: string): number {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const day = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (day !== undefined) return day % 7;
  } catch {
    // Unknown tag: fall back to Monday.
  }
  return 1;
}

export interface CalendarCell {
  date: Date;
  key: string;
  inMonth: boolean;
}

/** Six weeks of days around `month` (0-based) of `year`, starting on `firstDay`. */
export function monthGrid(year: number, month: number, firstDay: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - firstDay + 7) % 7;
  const cells: CalendarCell[] = [];
  for (let index = 0; index < 42; index++) {
    const date = new Date(year, month, 1 - offset + index);
    cells.push({ date, key: dayKey(date), inMonth: date.getMonth() === month });
  }
  return cells;
}

/** Start and end (exclusive) of a grid, for the task calendar query. */
export function gridRange(cells: readonly CalendarCell[]): { from: number; to: number } {
  const last = cells.at(-1)!.date;
  return {
    from: cells[0]!.date.getTime(),
    to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime(),
  };
}

/* ------------------------------- shelf ------------------------------- */

const sameItem = (a: Pick<ShelfItem, "root" | "path">, b: Pick<ShelfItem, "root" | "path">) =>
  a.root === b.root && a.path === b.path;

/** Adds items (newest first, without duplicates), keeping at most MAX_SHELF_ITEMS. */
export function shelfAdd(shelf: readonly ShelfItem[], items: readonly ShelfItem[]): ShelfItem[] {
  const fresh = items.filter(
    (item, index) => items.findIndex((other) => sameItem(other, item)) === index,
  );
  return [...fresh, ...shelf.filter((item) => !fresh.some((other) => sameItem(other, item)))].slice(
    0,
    MAX_SHELF_ITEMS,
  );
}

export function shelfRemove(
  shelf: readonly ShelfItem[],
  target: Pick<ShelfItem, "root" | "path">,
): ShelfItem[] {
  return shelf.filter((item) => !sameItem(item, target));
}

export const shelfName = (item: Pick<ShelfItem, "path">) =>
  item.path.split("/").filter(Boolean).at(-1) ?? item.path;

/** Reads the Files drag payload, or null when the drag carries something else. */
export function readFilesDrag(raw: string): { root: string; paths: string[] } | null {
  try {
    const value = JSON.parse(raw) as { root?: unknown; paths?: unknown };
    return typeof value.root === "string" &&
      Array.isArray(value.paths) &&
      value.paths.every((path) => typeof path === "string" && path.length > 0)
      ? { root: value.root, paths: value.paths as string[] }
      : null;
  } catch {
    return null;
  }
}

/* ---------------------------- dot matrix ---------------------------- */

export const MATRIX_COLS = 34;
export const MATRIX_ROWS = 5;

/**
 * Lit dots per column for CPU values (percent, oldest first): the newest
 * value is the rightmost column; missing history is empty on the left.
 * Any measurable load lights at least one dot.
 */
export function graphColumns(
  values: readonly number[],
  cols = MATRIX_COLS,
  rows = MATRIX_ROWS,
): number[] {
  const recent = values.slice(-cols);
  const heights = recent.map((value) =>
    !Number.isFinite(value) || value < 1
      ? 0
      : Math.min(rows, Math.max(1, Math.round((value / 100) * rows))),
  );
  return [...Array<number>(cols - heights.length).fill(0), ...heights];
}

/** Dots of three downward arrows ("drop here"), as "col:row" keys. */
export function arrowDots(cols = MATRIX_COLS, rows = MATRIX_ROWS): Set<string> {
  // A five-row arrow, five columns wide.
  const shape = [
    [2, 0],
    [2, 1],
    [0, 2],
    [2, 2],
    [4, 2],
    [1, 3],
    [2, 3],
    [3, 3],
    [2, 4],
  ] as const;
  const dots = new Set<string>();
  const top = Math.max(0, Math.floor((rows - 5) / 2));
  for (const center of [Math.round(cols / 4), Math.round(cols / 2), Math.round((cols * 3) / 4)])
    for (const [x, y] of shape) dots.add(`${center - 2 + x}:${top + y}`);
  return dots;
}
