import type { DesktopItem, DesktopPreferences, WallpaperSpec } from "@everyos/shared";
import { MAX_DESKTOPS } from "@everyos/shared";
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

/** Cells taken on a desktop: its shortcuts, and the Desktop folder's entries (on every desktop). */
function occupiedCells(doc: DesktopPreferences, desktopId: string): Set<string> {
  return new Set([
    ...onDesktop(doc, desktopId)
      .filter((item) => item.cell)
      .map((item) => cellKey(item.cell!)),
    ...doc.files.map((file) => cellKey(file.cell)),
  ]);
}

/** An icon on the desktop: a shortcut (by item id) or a Desktop-folder entry (by name). */
export type IconRef = { kind: "app"; id: string } | { kind: "file"; name: string };

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

export const fileCell = (doc: DesktopPreferences, name: string): Cell | null =>
  doc.files.find((file) => file.name === name)?.cell ?? null;

export function setIconCell(doc: DesktopPreferences, ref: IconRef, cell: Cell): DesktopPreferences {
  if (ref.kind === "app")
    return {
      ...doc,
      items: doc.items.map((item) => (item.id === ref.id ? { ...item, cell } : item)),
    };
  const known = doc.files.some((file) => file.name === ref.name);
  return {
    ...doc,
    files: known
      ? doc.files.map((file) => (file.name === ref.name ? { ...file, cell } : file))
      : [...doc.files, { name: ref.name, cell }],
  };
}

/**
 * Moves an icon to `to`. The icon shown there (`occupant`) swaps into the
 * cell the moved icon was shown in (`from`).
 */
export function moveIcon(
  doc: DesktopPreferences,
  ref: IconRef,
  to: Cell,
  from: Cell | null,
  occupant: IconRef | null,
): DesktopPreferences {
  const next = setIconCell(doc, ref, to);
  return occupant && from ? setIconCell(next, occupant, from) : next;
}

/** Keeps a Desktop-folder entry where it was when it is renamed. */
export function renameFilePosition(
  doc: DesktopPreferences,
  from: string,
  to: string,
): DesktopPreferences {
  if (!doc.files.some((file) => file.name === from)) return doc;
  return {
    ...doc,
    files: doc.files
      .filter((file) => file.name !== to)
      .map((file) => (file.name === from ? { ...file, name: to } : file)),
  };
}

/**
 * Matches the stored positions to a fresh listing of the Desktop folder:
 * positions of entries that are gone are dropped, new entries keep the cell
 * they were first shown in (so icons do not shuffle when others appear).
 * Returns the same document when nothing changed.
 */
export function reconcileFiles(
  doc: DesktopPreferences,
  present: ReadonlySet<string>,
  shown: ReadonlyMap<string, Cell>,
): DesktopPreferences {
  const kept = doc.files.filter((file) => present.has(file.name));
  const known = new Set(kept.map((file) => file.name));
  const added = [...shown]
    .filter(([name]) => present.has(name) && !known.has(name))
    .map(([name, cell]) => ({ name, cell }));
  if (added.length === 0 && kept.length === doc.files.length) return doc;
  return { ...doc, files: [...kept, ...added] };
}

/**
 * Legacy app groups: their shortcuts go back onto the desktop and the group
 * itself is dropped. With `keepAsFiles` (the caller created a real folder of
 * the same name in the Desktop folder), that folder takes the group's cell.
 */
export function dissolveAppGroups(
  doc: DesktopPreferences,
  keepAsFiles: boolean,
): DesktopPreferences {
  const groups = doc.items.filter(
    (item): item is Extract<DesktopItem, { kind: "folder" }> => item.kind === "folder",
  );
  if (groups.length === 0 && doc.items.every((item) => item.kind !== "app" || !item.folderId))
    return doc;
  let next: DesktopPreferences = {
    ...doc,
    items: doc.items.flatMap((item) => {
      if (item.kind === "folder") return [];
      return item.folderId ? [{ ...item, folderId: null, cell: null }] : [item];
    }),
  };
  if (keepAsFiles)
    for (const group of groups)
      if (group.cell && !next.files.some((file) => file.name === group.name))
        next = setIconCell(next, { kind: "file", name: group.name }, group.cell);
  return next;
}

/** Reassigns cells in reading order, sorted by name or by kind (folders, apps, files). */
export function arrangeIcons(
  doc: DesktopPreferences,
  icons: readonly { ref: IconRef; name: string; group: number }[],
  by: "name" | "kind",
  metrics: GridMetrics,
): DesktopPreferences {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const sorted = [...icons].sort((a, b) =>
    by === "kind" && a.group !== b.group ? a.group - b.group : collator.compare(a.name, b.name),
  );
  const occupied = new Set<string>();
  let next = doc;
  for (const icon of sorted) {
    const cell = firstFreeCell(occupied, metrics);
    occupied.add(cellKey(cell));
    next = setIconCell(next, icon.ref, cell);
  }
  return next;
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
