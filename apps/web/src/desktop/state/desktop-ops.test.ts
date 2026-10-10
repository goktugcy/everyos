import type { DesktopPreferences } from "@otuken/shared";
import { DesktopPreferencesSchema } from "@otuken/shared/schemas";
import { describe, expect, it } from "vitest";
import { cellAt, gridMetrics, placeItems } from "../surface/icon-grid.ts";
import {
  addDesktop,
  addShortcut,
  arrangeIcons,
  createFolder,
  deleteFolder,
  moveIntoFolder,
  moveItem,
  moveOutOfFolder,
  pruneUnavailable,
  removeDesktop,
  renameFolder,
} from "./desktop-ops.ts";

const metrics = gridMetrics("medium", { x: 0, y: 36, width: 1440, height: 780 });

function base(): DesktopPreferences {
  return {
    version: 1,
    desktops: [{ id: "d1", name: "Ana", wallpaper: null }],
    items: [
      {
        kind: "app",
        id: "a",
        appId: "otuken.system",
        desktopId: "d1",
        cell: { col: 0, row: 0 },
        folderId: null,
      },
      {
        kind: "app",
        id: "b",
        appId: "otuken.settings",
        desktopId: "d1",
        cell: { col: 0, row: 1 },
        folderId: null,
      },
    ],
  };
}

const valid = (doc: DesktopPreferences) =>
  expect(DesktopPreferencesSchema.safeParse(doc).success).toBe(true);

describe("icon grid", () => {
  it("derives the grid from the work area and icon size", () => {
    expect(metrics.columns).toBe(14);
    expect(metrics.rows).toBe(7);
    expect(cellAt({ x: 12 + 96 * 2 + 5, y: 36 + 12 + 106 + 5 }, metrics)).toEqual({
      col: 2,
      row: 1,
    });
    expect(cellAt({ x: -100, y: 99999 }, metrics)).toEqual({ col: 0, row: 6 });
  });

  it("keeps stored cells, resolves collisions and re-homes off-grid icons", () => {
    const small = gridMetrics("medium", { x: 0, y: 36, width: 300, height: 300 });
    const placed = placeItems(
      [
        {
          kind: "app",
          id: "a",
          appId: "otuken.system",
          desktopId: "d1",
          cell: { col: 0, row: 0 },
          folderId: null,
        },
        {
          kind: "app",
          id: "b",
          appId: "otuken.users",
          desktopId: "d1",
          cell: { col: 0, row: 0 },
          folderId: null,
        },
        {
          kind: "app",
          id: "c",
          appId: "otuken.audit",
          desktopId: "d1",
          cell: { col: 9, row: 9 },
          folderId: null,
        },
      ],
      small,
    );
    expect(placed.get("a")).toEqual({ col: 0, row: 0 });
    expect(new Set([...placed.values()].map((c) => `${c.col}:${c.row}`)).size).toBe(3);
    for (const cell of placed.values()) {
      expect(cell.col).toBeLessThan(small.columns);
      expect(cell.row).toBeLessThan(small.rows);
    }
  });
});

describe("desktop operations", () => {
  it("adds shortcuts to the first free cell", () => {
    const doc = addShortcut(base(), "otuken.users", "d1", metrics);
    expect(doc.items.at(-1)).toMatchObject({ appId: "otuken.users", cell: { col: 0, row: 2 } });
    valid(doc);
  });

  it("swaps icons when dropping onto an occupied cell", () => {
    const doc = moveItem(base(), "a", { col: 0, row: 1 });
    expect(doc.items.find((i) => i.id === "a")!.cell).toEqual({ col: 0, row: 1 });
    expect(doc.items.find((i) => i.id === "b")!.cell).toEqual({ col: 0, row: 0 });
  });

  it("manages folders and their contents", () => {
    const { doc: withFolder, id: folderId } = createFolder(base(), "d1", "Araçlar", metrics);
    let doc = moveIntoFolder(withFolder, "a", folderId);
    expect(doc.items.find((i) => i.id === "a")).toMatchObject({ folderId, cell: null });
    doc = renameFolder(doc, folderId, "  Yönetim  ");
    expect(doc.items.find((i) => i.id === folderId)).toMatchObject({ name: "Yönetim" });
    expect(renameFolder(doc, folderId, "   ")).toBe(doc);
    valid(doc);

    const out = moveOutOfFolder(doc, "a", metrics);
    expect(out.items.find((i) => i.id === "a")).toMatchObject({ folderId: null });
    const deleted = deleteFolder(doc, folderId, metrics);
    expect(deleted.items.some((i) => i.id === folderId)).toBe(false);
    expect(deleted.items.find((i) => i.id === "a")).toMatchObject({ folderId: null });
    expect(deleted.items.find((i) => i.id === "a")!.cell).not.toBeNull();
    valid(deleted);
  });

  it("arranges icons by name with folders first when sorting by kind", () => {
    const { doc } = createFolder(base(), "d1", "Zeta", metrics);
    const names: Record<string, string> = { a: "Sistem", b: "Ayarlar" };
    const nameOf = (item: { id: string; kind: string; name?: string }) =>
      item.kind === "folder" ? item.name! : names[item.id]!;
    const byName = arrangeIcons(doc, "d1", "name", nameOf, metrics);
    expect(byName.items.find((i) => i.id === "b")!.cell).toEqual({ col: 0, row: 0 });
    const byKind = arrangeIcons(doc, "d1", "kind", nameOf, metrics);
    expect(byKind.items.find((i) => i.kind === "folder")!.cell).toEqual({ col: 0, row: 0 });
  });

  it("adds and removes virtual desktops without losing icons", () => {
    const { doc: two, id } = addDesktop(base(), "İkinci");
    const withIcon = addShortcut(two, "otuken.audit", id!, metrics);
    const removed = removeDesktop(withIcon, id!, metrics);
    expect(removed.desktops.map((d) => d.id)).toEqual(["d1"]);
    expect(removed.items.find((i) => i.kind === "app" && i.appId === "otuken.audit")).toMatchObject(
      { desktopId: "d1" },
    );
    expect(removeDesktop(base(), "d1", metrics)).toEqual(base());
    valid(removed);
  });

  it("caps the number of desktops", () => {
    let doc = base();
    for (let i = 0; i < 10; i++) doc = addDesktop(doc, `D${i}`).doc;
    expect(doc.desktops).toHaveLength(8);
  });

  it("prunes shortcuts to apps that are no longer available", () => {
    const doc = pruneUnavailable(base(), (appId) => appId !== "otuken.settings");
    expect(doc.items.map((i) => i.id)).toEqual(["a"]);
  });
});
