import {
  WIDGET_CELL_PX,
  type Permission,
  type WidgetInstance,
  type WidgetPlacement,
  type WidgetPreferences,
  type WidgetSize,
} from "@everyos/shared";
import {
  addWidget,
  changePlacement,
  defaultWidgetPreferences,
  duplicateWidget,
  getWidget,
  LayoutError,
  moveWidget,
  removeWidget,
  reorderWidget,
  resizeWidget,
  updateWidget,
} from "@everyos/widget-sdk";
import { workArea, type Viewport } from "@everyos/window-manager";
import { randomId } from "../../lib/random-id.ts";
import { resetPreference, updatePreference, usePreferences } from "../state/preferences-store.ts";
import { wm } from "../state/window-store.ts";
import { effectiveCells, type ScreenGrid } from "./geometry.ts";

export type { ScreenGrid };

/** The visible desktop grid (cells of WIDGET_CELL_PX) inside the window work area. */
export function gridOf(viewport: Viewport): ScreenGrid {
  const work = workArea(viewport);
  return {
    originX: work.x,
    originY: work.y,
    columns: Math.max(1, Math.floor(work.width / WIDGET_CELL_PX)),
    rows: Math.max(1, Math.floor(work.height / WIDGET_CELL_PX)),
  };
}

export function desktopGrid(): ScreenGrid {
  return gridOf(wm().viewport);
}

export type WidgetActionResult = { ok: true } | { ok: false; reason: LayoutError["reason"] };

export type WidgetAddResult =
  { ok: true; id: string } | { ok: false; reason: LayoutError["reason"] };

function apply(change: (doc: WidgetPreferences) => WidgetPreferences): WidgetActionResult {
  try {
    const current = usePreferences.getState().widgets;
    const next = change(current);
    if (next !== current) updatePreference("widgets", () => next);
    return { ok: true };
  } catch (error) {
    if (error instanceof LayoutError) return { ok: false, reason: error.reason };
    throw error;
  }
}

const newId = randomId;

/**
 * Adopts what the user sees: widgets that were shifted to fit a narrower
 * work area keep their on-screen cells, so placement checks match the screen.
 */
function settle(doc: WidgetPreferences): WidgetPreferences {
  const active = wm().activeDesktopId;
  const visible = doc.instances.filter(
    (i) =>
      i.placement === "desktop" &&
      i.position !== null &&
      (i.desktopId === null || i.desktopId === active),
  );
  const cells = effectiveCells(visible, desktopGrid());
  let changed = false;
  const instances = doc.instances.map((i) => {
    const cell = cells.get(i.id);
    if (!cell || (cell.col === i.position?.col && cell.row === i.position.row)) return i;
    changed = true;
    return { ...i, position: cell };
  });
  return changed ? { ...doc, instances } : doc;
}

/** Layout operations on the signed-in user's widgets (saved like every preference). */
export const widgetActions = {
  add(
    widgetId: string,
    placement: WidgetPlacement,
    options: { size?: WidgetSize; config?: WidgetInstance["config"] } = {},
  ): WidgetAddResult {
    const manifest = getWidget(widgetId);
    if (!manifest) return { ok: false, reason: "placement" };
    const id = newId();
    const result = apply((doc) =>
      addWidget(settle(doc), manifest, {
        id,
        placement,
        desktopId: wm().activeDesktopId,
        grid: desktopGrid(),
        ...(options.size ? { size: options.size } : {}),
        ...(options.config ? { config: options.config } : {}),
      }),
    );
    return result.ok ? { ok: true, id } : result;
  },
  update(id: string, patch: Parameters<typeof updateWidget>[2]): void {
    apply((doc) => updateWidget(doc, id, patch));
  },
  remove(id: string): void {
    apply((doc) => removeWidget(doc, id));
  },
  /** False when refused (outside the grid, overlapping or locked). */
  move(id: string, position: { col: number; row: number }): boolean {
    let moved = false;
    apply((doc) => {
      const settled = settle(doc);
      const next = moveWidget(settled, id, position, desktopGrid());
      moved = next !== settled;
      return moved ? next : doc;
    });
    return moved;
  },
  /** False when refused (no room, unsupported size or locked). */
  resize(id: string, size: WidgetSize, custom: { w: number; h: number } | null): boolean {
    let resized = false;
    apply((doc) => {
      const settled = settle(doc);
      const next = resizeWidget(settled, id, size, custom, desktopGrid());
      resized = next !== settled;
      return resized ? next : doc;
    });
    return resized;
  },
  duplicate(id: string): WidgetActionResult {
    return apply((doc) => duplicateWidget(settle(doc), id, newId(), desktopGrid()));
  },
  place(id: string, placement: WidgetPlacement): WidgetActionResult {
    return apply((doc) =>
      changePlacement(settle(doc), id, placement, wm().activeDesktopId, desktopGrid()),
    );
  },
  reorder(id: string, step: -1 | 1): void {
    apply((doc) => reorderWidget(doc, id, step));
  },
  setSidebar(open: boolean): void {
    apply((doc) => ({ ...doc, sidebar: { open } }));
  },
  restoreDefaults(permissions: readonly Permission[]): void {
    resetPreference("widgets", {
      ...defaultWidgetPreferences(permissions, newId),
      sidebar: { open: true },
    });
  },
};
