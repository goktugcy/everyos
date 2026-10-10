import { WIDGET_CELL_PX, WIDGET_CUSTOM_LIMITS, type WidgetInstance } from "@otuken/shared";
import { cellsOf } from "@otuken/widget-sdk";
import { GripVertical } from "lucide-react";
import {
  memo,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../state/preferences-store.ts";
import { useWindowManager } from "../state/window-store.ts";
import { gridOf, widgetActions, type ScreenGrid } from "./actions.ts";
import { WidgetFrame } from "./frame.tsx";
import { cellBox, DRAG_THRESHOLD, effectiveCells, GAP, type Cell } from "./geometry.ts";
import { layoutErrorMessage } from "./labels.ts";
import { widgetUi } from "./ui-store.ts";

const DesktopWidget = memo(function DesktopWidget({
  instance,
  grid,
  cell,
}: {
  instance: WidgetInstance;
  grid: ScreenGrid;
  /** Effective cell (see `effectiveCells`). */
  cell: Cell;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ cell: Cell; size: { w: number; h: number } } | null>(
    null,
  );
  const size = cellsOf(instance);
  const box = cellBox(cell, size, grid);

  const snap = (value: number) => Math.round(value / WIDGET_CELL_PX);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || instance.locked) return;
    // React bubbles events from portals (the widget's own menus) through this header.
    const origin = event.target as HTMLElement;
    if (!event.currentTarget.contains(origin) || origin.closest("button")) return;
    const element = ref.current!;
    const startX = event.clientX;
    const startY = event.clientY;
    let target: Cell | null = null;
    element.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - startX;
      const dy = pointer.clientY - startY;
      if (!target && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      element.style.zIndex = "2";
      const next = {
        col: Math.max(0, Math.min(grid.columns - size.w, cell.col + snap(dx))),
        row: Math.max(0, Math.min(grid.rows - size.h, cell.row + snap(dy))),
      };
      if (!target || next.col !== target.col || next.row !== target.row) {
        target = next;
        setPreview({ cell: next, size });
      }
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.style.transform = "";
      element.style.zIndex = "";
      setPreview(null);
      // Overlapping another widget is refused: the widget snaps back.
      if (target && (target.col !== cell.col || target.row !== cell.row))
        widgetActions.move(instance.id, target);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  const startResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || instance.locked) return;
    event.stopPropagation();
    const element = ref.current!;
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    let next = size;
    handle.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const width = box.width + pointer.clientX - startX;
      const height = box.height + pointer.clientY - startY;
      element.style.width = `${Math.max(WIDGET_CELL_PX - GAP, width)}px`;
      element.style.height = `${Math.max(WIDGET_CELL_PX - GAP, height)}px`;
      next = {
        w: Math.max(
          WIDGET_CUSTOM_LIMITS.minW,
          Math.min(WIDGET_CUSTOM_LIMITS.maxW, grid.columns - cell.col, snap(width + GAP)),
        ),
        h: Math.max(
          WIDGET_CUSTOM_LIMITS.minH,
          Math.min(WIDGET_CUSTOM_LIMITS.maxH, grid.rows - cell.row, snap(height + GAP)),
        ),
      };
      setPreview({ cell, size: next });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      // Back to the rendered size (React re-renders only if the resize is accepted).
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
      setPreview(null);
      if (next.w !== size.w || next.h !== size.h) {
        if (!widgetActions.resize(instance.id, "custom", next))
          widgetUi.notify(layoutErrorMessage(t, "no-space"));
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const delta = deltas[event.key];
    if (!delta || instance.locked) return;
    event.preventDefault();
    widgetActions.move(instance.id, { col: cell.col + delta[0], row: cell.row + delta[1] });
  };

  return (
    <>
      {preview ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-otk-lg border-2 border-dashed border-[rgb(var(--otk-accent)/0.7)] bg-[rgb(var(--otk-accent)/0.08)]"
          style={cellBox(preview.cell, preview.size, grid)}
        />
      ) : null}
      <div
        ref={ref}
        className="pointer-events-auto fixed"
        data-testid="desktop-widget"
        data-widget-id={instance.id}
        style={box}
      >
        <WidgetFrame instance={instance} className="h-full w-full" onHeaderPointerDown={startDrag}>
          {!instance.locked ? (
            <>
              <button
                type="button"
                aria-label={t("widgets.menu.dragHandle")}
                className="sr-only focus:not-sr-only focus:absolute focus:left-1 focus:top-1 focus:grid focus:size-6 focus:place-items-center focus:rounded-md focus:bg-hover/20"
                onKeyDown={onKeyDown}
              >
                <GripVertical className="size-4" aria-hidden />
              </button>
              <span
                role="presentation"
                title={t("widgets.menu.resizeHandle")}
                data-testid="widget-resize"
                className="absolute bottom-0 right-0 size-4 cursor-nwse-resize touch-none opacity-0 transition-opacity group-hover/widget:opacity-100"
                onPointerDown={startResize}
              >
                <span className="absolute bottom-1 right-1 size-2 rounded-br-[4px] border-b-2 border-r-2 border-fg-subtle" />
              </span>
            </>
          ) : null}
        </WidgetFrame>
      </div>
    </>
  );
});

/** Desktop widgets of the active virtual desktop (and pinned ones) on the cell grid. */
export function WidgetDesktopLayer() {
  const instances = usePreferences((state) => state.widgets.instances);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const viewport = useWindowManager((state) => state.viewport);
  const grid = useMemo(() => gridOf(viewport), [viewport]);
  const desktops = usePreferences((state) => state.desktop.desktops);
  const firstDesktop = desktops[0]?.id;
  const visible = instances.filter((instance) => {
    if (instance.placement !== "desktop" || instance.position === null) return false;
    if (instance.desktopId === null || instance.desktopId === activeDesktopId) return true;
    // A removed desktop's widgets show on the first one until the layout is saved again.
    return activeDesktopId === firstDesktop && !desktops.some((d) => d.id === instance.desktopId);
  });
  const cells = effectiveCells(visible, grid);
  return (
    <div className="pointer-events-none absolute inset-0 z-[15]" data-testid="widget-layer">
      {visible.map((instance) => (
        <DesktopWidget
          key={instance.id}
          instance={instance}
          grid={grid}
          cell={cells.get(instance.id) ?? { col: 0, row: 0 }}
        />
      ))}
    </div>
  );
}
