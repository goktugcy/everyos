import {
  MAX_WIDGET_INSTANCES,
  WIDGET_CUSTOM_LIMITS,
  type Permission,
  type WidgetInstance,
  type WidgetPlacement,
  type WidgetPreferences,
  type WidgetSize,
} from "@otuken/shared";
import { cellsOf, sizesFor, supportsPlacement } from "./compat.ts";
import { defaultConfig } from "./config.ts";
import { getWidget } from "./manifests.ts";
import type { WidgetManifest } from "./types.ts";

/** Visible desktop grid (cells) used to place and clamp desktop widgets. */
export interface DesktopGrid {
  columns: number;
  rows: number;
}

export const EMPTY_WIDGETS: WidgetPreferences = {
  version: 1,
  instances: [],
  sidebar: { open: false },
};

type Rect = { col: number; row: number; w: number; h: number };

function rectOf(instance: WidgetInstance): Rect | null {
  if (instance.placement !== "desktop" || !instance.position) return null;
  return { ...instance.position, ...cellsOf(instance) };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** Widgets sharing a desktop with `desktopId` (pinned widgets appear on every desktop). */
function neighbours(doc: WidgetPreferences, desktopId: string | null, exceptId?: string): Rect[] {
  return doc.instances
    .filter(
      (i) =>
        i.id !== exceptId &&
        i.placement === "desktop" &&
        (desktopId === null || i.desktopId === null || i.desktopId === desktopId),
    )
    .map(rectOf)
    .filter((r): r is Rect => r !== null);
}

function fits(rect: Rect, others: readonly Rect[], grid: DesktopGrid): boolean {
  return (
    rect.col >= 0 &&
    rect.row >= 0 &&
    rect.col + rect.w <= grid.columns &&
    rect.row + rect.h <= grid.rows &&
    !others.some((other) => overlaps(rect, other))
  );
}

/** First free spot, scanning from the top-right (icons fill the desktop from the left). */
export function findFreeCell(
  doc: WidgetPreferences,
  size: { w: number; h: number },
  desktopId: string | null,
  grid: DesktopGrid,
): { col: number; row: number } | null {
  const others = neighbours(doc, desktopId);
  for (let col = grid.columns - size.w; col >= 0; col--) {
    for (let row = 0; row + size.h <= grid.rows; row++) {
      if (fits({ col, row, ...size }, others, grid)) return { col, row };
    }
  }
  return null;
}

function nextOrder(doc: WidgetPreferences, placement: WidgetPlacement): number {
  return (
    Math.max(-1, ...doc.instances.filter((i) => i.placement === placement).map((i) => i.order)) + 1
  );
}

export class LayoutError extends Error {
  readonly reason: "limit" | "no-space" | "placement";

  constructor(reason: LayoutError["reason"]) {
    super(`Widget layout: ${reason}`);
    this.name = "LayoutError";
    this.reason = reason;
  }
}

export interface AddOptions {
  id: string;
  placement: WidgetPlacement;
  size?: WidgetSize;
  desktopId: string | null;
  grid: DesktopGrid;
  config?: WidgetInstance["config"];
}

export function createInstance(
  manifest: WidgetManifest,
  options: Omit<AddOptions, "grid">,
): WidgetInstance {
  const sizes = sizesFor(manifest, options.placement);
  const size =
    options.size && sizes.includes(options.size)
      ? options.size
      : sizes.includes(manifest.defaultSize)
        ? manifest.defaultSize
        : sizes[0]!;
  return {
    id: options.id,
    widgetId: manifest.id,
    widgetVersion: manifest.version,
    placement: options.placement,
    size,
    custom: null,
    position: null,
    desktopId: options.placement === "desktop" ? options.desktopId : null,
    order: 0,
    opacity: 1,
    locked: false,
    config: { ...defaultConfig(manifest), ...(options.config ?? {}) },
  };
}

/** Adds a widget; desktop widgets get the first free cell. Throws `LayoutError`. */
export function addWidget(
  doc: WidgetPreferences,
  manifest: WidgetManifest,
  options: AddOptions,
): WidgetPreferences {
  if (doc.instances.length >= MAX_WIDGET_INSTANCES) throw new LayoutError("limit");
  if (!supportsPlacement(manifest, options.placement)) throw new LayoutError("placement");
  const instance = createInstance(manifest, options);
  if (instance.placement === "desktop") {
    const position = findFreeCell(doc, cellsOf(instance), instance.desktopId, options.grid);
    if (!position) throw new LayoutError("no-space");
    instance.position = position;
  } else {
    instance.order = nextOrder(doc, instance.placement);
  }
  return { ...doc, instances: [...doc.instances, instance] };
}

export function updateWidget(
  doc: WidgetPreferences,
  id: string,
  patch: Partial<Pick<WidgetInstance, "config" | "opacity" | "locked" | "desktopId">>,
): WidgetPreferences {
  return {
    ...doc,
    instances: doc.instances.map((i) =>
      i.id === id
        ? {
            ...i,
            ...patch,
            ...(patch.opacity !== undefined
              ? { opacity: Math.min(1, Math.max(0.3, patch.opacity)) }
              : {}),
          }
        : i,
    ),
  };
}

export function removeWidget(doc: WidgetPreferences, id: string): WidgetPreferences {
  return { ...doc, instances: doc.instances.filter((i) => i.id !== id) };
}

/** Moves a desktop widget; refused (unchanged) when it would leave the grid or overlap another. */
export function moveWidget(
  doc: WidgetPreferences,
  id: string,
  position: { col: number; row: number },
  grid: DesktopGrid,
): WidgetPreferences {
  const instance = doc.instances.find((i) => i.id === id);
  if (!instance || instance.placement !== "desktop" || instance.locked) return doc;
  if (!fits({ ...position, ...cellsOf(instance) }, neighbours(doc, instance.desktopId, id), grid))
    return doc;
  return { ...doc, instances: doc.instances.map((i) => (i.id === id ? { ...i, position } : i)) };
}

/** Changes a widget's size; refused (unchanged) when the desktop has no room for it. */
export function resizeWidget(
  doc: WidgetPreferences,
  id: string,
  size: WidgetSize,
  custom: { w: number; h: number } | null,
  grid: DesktopGrid,
): WidgetPreferences {
  const instance = doc.instances.find((i) => i.id === id);
  const manifest = instance ? getWidget(instance.widgetId) : undefined;
  if (
    !instance ||
    !manifest ||
    instance.locked ||
    !sizesFor(manifest, instance.placement).includes(size)
  )
    return doc;
  const clamped =
    size === "custom" && custom
      ? {
          w: Math.min(
            WIDGET_CUSTOM_LIMITS.maxW,
            Math.max(WIDGET_CUSTOM_LIMITS.minW, Math.round(custom.w)),
          ),
          h: Math.min(
            WIDGET_CUSTOM_LIMITS.maxH,
            Math.max(WIDGET_CUSTOM_LIMITS.minH, Math.round(custom.h)),
          ),
        }
      : null;
  if (size === "custom" && !clamped) return doc;
  const next = { ...instance, size, custom: clamped };
  if (next.placement === "desktop" && next.position) {
    if (!fits({ ...next.position, ...cellsOf(next) }, neighbours(doc, next.desktopId, id), grid))
      return doc;
  }
  return { ...doc, instances: doc.instances.map((i) => (i.id === id ? next : i)) };
}

export function duplicateWidget(
  doc: WidgetPreferences,
  id: string,
  newId: string,
  grid: DesktopGrid,
): WidgetPreferences {
  const instance = doc.instances.find((i) => i.id === id);
  if (!instance) return doc;
  if (doc.instances.length >= MAX_WIDGET_INSTANCES) throw new LayoutError("limit");
  const copy: WidgetInstance = {
    ...instance,
    id: newId,
    locked: false,
    config: { ...instance.config },
  };
  if (copy.placement === "desktop") {
    const position = findFreeCell(doc, cellsOf(copy), copy.desktopId, grid);
    if (!position) throw new LayoutError("no-space");
    copy.position = position;
  } else {
    copy.order = nextOrder(doc, copy.placement);
  }
  return { ...doc, instances: [...doc.instances, copy] };
}

/** Moves a widget to another placement, keeping its configuration. */
export function changePlacement(
  doc: WidgetPreferences,
  id: string,
  placement: WidgetPlacement,
  desktopId: string | null,
  grid: DesktopGrid,
): WidgetPreferences {
  const instance = doc.instances.find((i) => i.id === id);
  const manifest = instance ? getWidget(instance.widgetId) : undefined;
  if (!instance || !manifest || instance.placement === placement) return doc;
  if (!supportsPlacement(manifest, placement)) throw new LayoutError("placement");
  const sizes = sizesFor(manifest, placement);
  const moved: WidgetInstance = {
    ...instance,
    placement,
    size: sizes.includes(instance.size)
      ? instance.size
      : sizes.includes(manifest.defaultSize)
        ? manifest.defaultSize
        : sizes[0]!,
    custom: null,
    position: null,
    desktopId: placement === "desktop" ? desktopId : null,
    order: 0,
  };
  const rest = removeWidget(doc, id);
  if (placement === "desktop") {
    const position = findFreeCell(rest, cellsOf(moved), moved.desktopId, grid);
    if (!position) throw new LayoutError("no-space");
    moved.position = position;
  } else {
    moved.order = nextOrder(rest, placement);
  }
  return { ...rest, instances: [...rest.instances, moved] };
}

/** Moves a sidebar or menu bar widget one step earlier (-1) or later (+1). */
export function reorderWidget(doc: WidgetPreferences, id: string, step: -1 | 1): WidgetPreferences {
  const instance = doc.instances.find((i) => i.id === id);
  if (!instance || instance.placement === "desktop") return doc;
  const ordered = doc.instances
    .filter((i) => i.placement === instance.placement)
    .sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((i) => i.id === id);
  const target = index + step;
  if (target < 0 || target >= ordered.length) return doc;
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  const orders = new Map(ordered.map((i, position) => [i.id, position]));
  return {
    ...doc,
    instances: doc.instances.map((i) =>
      orders.has(i.id) ? { ...i, order: orders.get(i.id)! } : i,
    ),
  };
}

/** Widgets in a sidebar or the menu bar, in display order. */
export function ordered(
  doc: WidgetPreferences,
  placement: Exclude<WidgetPlacement, "desktop">,
): WidgetInstance[] {
  return doc.instances.filter((i) => i.placement === placement).sort((a, b) => a.order - b.order);
}

/** "Restore default layout": a few system widgets in the (closed) sidebar. */
export function defaultWidgetPreferences(
  permissions: readonly Permission[],
  newId: () => string,
): WidgetPreferences {
  let doc: WidgetPreferences = { ...EMPTY_WIDGETS, instances: [] };
  for (const widgetId of ["system.cpu", "system.memory", "system.network", "system.diskUsage"]) {
    const manifest = getWidget(widgetId);
    if (!manifest || !manifest.permissions.every((p) => permissions.includes(p))) continue;
    doc = addWidget(doc, manifest, {
      id: newId(),
      placement: "sidebar",
      desktopId: null,
      grid: { columns: 0, rows: 0 },
    });
  }
  return doc;
}

/**
 * Widgets on virtual desktops that no longer exist (removed, or a default
 * desktop that was never saved) move to the first desktop, like windows do.
 */
export function reassignDesktops(
  doc: WidgetPreferences,
  desktopIds: readonly string[],
): WidgetPreferences {
  const first = desktopIds[0];
  if (!first) return doc;
  const orphaned = (i: WidgetInstance) => i.desktopId !== null && !desktopIds.includes(i.desktopId);
  if (!doc.instances.some(orphaned)) return doc;
  return {
    ...doc,
    instances: doc.instances.map((i) => (orphaned(i) ? { ...i, desktopId: first } : i)),
  };
}
