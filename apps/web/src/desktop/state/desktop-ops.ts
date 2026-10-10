import type { DesktopItem, DesktopPreferences, WallpaperSpec } from "@otuken/shared";
import { MAX_DESKTOPS } from "@otuken/shared";
import { cellKey, firstFreeCell, type Cell, type GridMetrics } from "../surface/icon-grid.ts";
import { newId } from "./ids.ts";

/*
 * Pure transformations of the desktop preference document. Components call
 * these through updatePreference("desktop", …) so every change is persisted.
 */

const onDesktop = (doc: DesktopPreferences, desktopId: string) =>
  doc.items.filter(
    (item) => item.desktopId === desktopId && (item.kind === "folder" || item.folderId === null),
  );

function occupiedCells(doc: DesktopPreferences, desktopId: string, except?: string): Set<string> {
  return new Set(
    onDesktop(doc, desktopId)
      .filter((item) => item.id !== except && item.cell)
      .map((item) => cellKey(item.cell!)),
  );
}

export function addShortcut(
  doc: DesktopPreferences,
  appId: string,
  desktopId: string,
  metrics: GridMetrics,
): DesktopPreferences {
  const cell = firstFreeCell(occupiedCells(doc, desktopId), metrics);
  return {
    ...doc,
    items: [...doc.items, { kind: "app", id: newId("i"), appId, desktopId, cell, folderId: null }],
  };
}

export function removeItem(doc: DesktopPreferences, id: string): DesktopPreferences {
  return { ...doc, items: doc.items.filter((item) => item.id !== id) };
}

/** Moves an icon to a cell; an icon already there swaps into the vacated cell. */
export function moveItem(doc: DesktopPreferences, id: string, cell: Cell): DesktopPreferences {
  const moving = doc.items.find((item) => item.id === id);
  if (!moving) return doc;
  const from = moving.cell;
  const target = onDesktop(doc, moving.desktopId).find(
    (item) =>
      item.id !== id && item.cell && item.cell.col === cell.col && item.cell.row === cell.row,
  );
  return {
    ...doc,
    items: doc.items.map((item) => {
      if (item.id === id) return { ...item, cell };
      if (target && item.id === target.id) return { ...item, cell: from };
      return item;
    }),
  };
}

export function createFolder(
  doc: DesktopPreferences,
  desktopId: string,
  name: string,
  metrics: GridMetrics,
): { doc: DesktopPreferences; id: string } {
  const id = newId("f");
  const cell = firstFreeCell(occupiedCells(doc, desktopId), metrics);
  return {
    id,
    doc: { ...doc, items: [...doc.items, { kind: "folder", id, name, desktopId, cell }] },
  };
}

export function renameFolder(
  doc: DesktopPreferences,
  id: string,
  name: string,
): DesktopPreferences {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return doc;
  return {
    ...doc,
    items: doc.items.map((item) =>
      item.id === id && item.kind === "folder" ? { ...item, name: trimmed } : item,
    ),
  };
}

export function moveIntoFolder(
  doc: DesktopPreferences,
  itemId: string,
  folderId: string,
): DesktopPreferences {
  const folder = doc.items.find((item) => item.id === folderId && item.kind === "folder");
  if (!folder) return doc;
  return {
    ...doc,
    items: doc.items.map((item) =>
      item.id === itemId && item.kind === "app"
        ? { ...item, folderId, desktopId: folder.desktopId, cell: null }
        : item,
    ),
  };
}

export function moveOutOfFolder(
  doc: DesktopPreferences,
  itemId: string,
  metrics: GridMetrics,
): DesktopPreferences {
  const item = doc.items.find((entry) => entry.id === itemId);
  if (!item || item.kind !== "app" || item.folderId === null) return doc;
  const cell = firstFreeCell(occupiedCells(doc, item.desktopId), metrics);
  return {
    ...doc,
    items: doc.items.map((entry) =>
      entry.id === itemId ? { ...item, folderId: null, cell } : entry,
    ),
  };
}

/** Deletes a folder; its shortcuts move back onto the desktop. */
export function deleteFolder(
  doc: DesktopPreferences,
  folderId: string,
  metrics: GridMetrics,
): DesktopPreferences {
  const folder = doc.items.find((item) => item.id === folderId);
  if (!folder || folder.kind !== "folder") return doc;
  let next: DesktopPreferences = {
    ...doc,
    items: doc.items.filter((item) => item.id !== folderId),
  };
  for (const child of doc.items) {
    if (child.kind === "app" && child.folderId === folderId)
      next = moveOutOfFolder(next, child.id, metrics);
  }
  return next;
}

/** Reassigns cells in reading order, sorted by name or by kind. */
export function arrangeIcons(
  doc: DesktopPreferences,
  desktopId: string,
  by: "name" | "kind",
  nameOf: (item: DesktopItem) => string,
  metrics: GridMetrics,
): DesktopPreferences {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const sorted = [...onDesktop(doc, desktopId)].sort((a, b) =>
    by === "kind" && a.kind !== b.kind
      ? a.kind === "folder"
        ? -1
        : 1
      : collator.compare(nameOf(a), nameOf(b)),
  );
  const cells = new Map<string, Cell>();
  const occupied = new Set<string>();
  for (const item of sorted) {
    const cell = firstFreeCell(occupied, metrics);
    cells.set(item.id, cell);
    occupied.add(cellKey(cell));
  }
  return {
    ...doc,
    items: doc.items.map((item) =>
      cells.has(item.id) ? { ...item, cell: cells.get(item.id)! } : item,
    ),
  };
}

export function addDesktop(
  doc: DesktopPreferences,
  name: string,
): { doc: DesktopPreferences; id: string | null } {
  if (doc.desktops.length >= MAX_DESKTOPS) return { doc, id: null };
  const id = newId("d");
  return {
    id,
    doc: { ...doc, desktops: [...doc.desktops, { id, name: name.slice(0, 32), wallpaper: null }] },
  };
}

export function renameDesktop(
  doc: DesktopPreferences,
  id: string,
  name: string,
): DesktopPreferences {
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) return doc;
  return {
    ...doc,
    desktops: doc.desktops.map((desktop) =>
      desktop.id === id ? { ...desktop, name: trimmed } : desktop,
    ),
  };
}

/** Removes a desktop; its icons move to the first remaining desktop. */
export function removeDesktop(
  doc: DesktopPreferences,
  id: string,
  metrics: GridMetrics,
): DesktopPreferences {
  if (doc.desktops.length <= 1) return doc;
  const remaining = doc.desktops.filter((desktop) => desktop.id !== id);
  const target = remaining[0]!.id;
  let next: DesktopPreferences = { ...doc, desktops: remaining };
  for (const item of doc.items) {
    if (item.desktopId !== id) continue;
    const isTopLevel = item.kind === "folder" || item.folderId === null;
    const cell = isTopLevel ? firstFreeCell(occupiedCells(next, target), metrics) : null;
    next = {
      ...next,
      items: next.items.map((entry) =>
        entry.id === item.id ? { ...entry, desktopId: target, cell } : entry,
      ),
    };
  }
  return next;
}

export function setDesktopWallpaper(
  doc: DesktopPreferences,
  id: string,
  wallpaper: WallpaperSpec | null,
): DesktopPreferences {
  return {
    ...doc,
    desktops: doc.desktops.map((desktop) =>
      desktop.id === id ? { ...desktop, wallpaper } : desktop,
    ),
  };
}

/** Removes shortcuts to apps the user can no longer open (e.g. after a role change). */
export function pruneUnavailable(
  doc: DesktopPreferences,
  isAvailable: (appId: string) => boolean,
): DesktopPreferences {
  const items = doc.items.filter((item) => item.kind === "folder" || isAvailable(item.appId));
  return items.length === doc.items.length ? doc : { ...doc, items };
}
