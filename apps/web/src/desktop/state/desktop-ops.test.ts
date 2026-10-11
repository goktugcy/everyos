import type { DesktopPreferences } from "@otuken/shared";
import { DesktopPreferencesSchema } from "@otuken/shared/schemas";
import { describe, expect, it } from "vitest";
import { cellAt, gridMetrics, placeItems } from "../surface/icon-grid.ts";
import {
  addDesktop,
  addShortcut,
  arrangeIcons,
  dissolveAppGroups,
  fileCell,
  moveIcon,
  pruneUnavailable,
  reconcileFiles,
  removeDesktop,
  renameFilePosition,
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
    files: [],
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

  it("fills Desktop-folder entries from the top right, like macOS", () => {
    const placed = placeItems(
      [
        { id: "app", cell: null, file: false },
        { id: "file:a", cell: null, file: true },
        { id: "file:b", cell: null, file: true },
      ],
      metrics,
      (item) => item.file,
    );
    expect(placed.get("app")).toEqual({ col: 0, row: 0 });
    expect(placed.get("file:a")).toEqual({ col: metrics.columns - 1, row: 0 });
    expect(placed.get("file:b")).toEqual({ col: metrics.columns - 1, row: 1 });
  });
});

describe("desktop operations", () => {
  it("adds shortcuts to the first free cell, around the Desktop folder's entries", () => {
    const doc = addShortcut(
      { ...base(), files: [{ name: "Notlar", cell: { col: 0, row: 2 } }] },
      "otuken.users",
      "d1",
      metrics,
    );
    expect(doc.items.at(-1)).toMatchObject({ appId: "otuken.users", cell: { col: 0, row: 3 } });
    valid(doc);
  });

  it("swaps a moved icon with the one shown in the target cell", () => {
    const doc = moveIcon(
      base(),
      { kind: "app", id: "a" },
      { col: 0, row: 1 },
      { col: 0, row: 0 },
      { kind: "app", id: "b" },
    );
    expect(doc.items.find((i) => i.id === "a")!.cell).toEqual({ col: 0, row: 1 });
    expect(doc.items.find((i) => i.id === "b")!.cell).toEqual({ col: 0, row: 0 });
    // Files and shortcuts swap the same way.
    const mixed = moveIcon(
      doc,
      { kind: "file", name: "rapor.pdf" },
      { col: 0, row: 0 },
      { col: 13, row: 0 },
      { kind: "app", id: "b" },
    );
    expect(fileCell(mixed, "rapor.pdf")).toEqual({ col: 0, row: 0 });
    expect(mixed.items.find((i) => i.id === "b")!.cell).toEqual({ col: 13, row: 0 });
    valid(mixed);
  });

  it("keeps Desktop-folder entries in place across renames and new listings", () => {
    let doc: DesktopPreferences = {
      ...base(),
      files: [{ name: "a.txt", cell: { col: 13, row: 0 } }],
    };
    doc = renameFilePosition(doc, "a.txt", "b.txt");
    expect(doc.files).toEqual([{ name: "b.txt", cell: { col: 13, row: 0 } }]);
    // New entries keep where they were first shown; vanished ones are forgotten.
    const shown = new Map([
      ["b.txt", { col: 5, row: 5 }],
      ["Yeni klasör", { col: 13, row: 1 }],
    ]);
    const next = reconcileFiles(doc, new Set(["b.txt", "Yeni klasör"]), shown);
    expect(next.files).toEqual([
      { name: "b.txt", cell: { col: 13, row: 0 } },
      { name: "Yeni klasör", cell: { col: 13, row: 1 } },
    ]);
    expect(reconcileFiles(next, new Set(["b.txt", "Yeni klasör"]), shown)).toBe(next);
    expect(reconcileFiles(next, new Set(["b.txt"]), shown).files).toHaveLength(1);
    valid(next);
  });

  it("turns legacy app groups into Desktop-folder entries and frees their shortcuts", () => {
    const legacy: DesktopPreferences = {
      ...base(),
      items: [
        ...base().items.map((item) =>
          item.id === "a" ? { ...item, folderId: "g", cell: null } : item,
        ),
        { kind: "folder", id: "g", name: "Araçlar", desktopId: "d1", cell: { col: 3, row: 2 } },
      ],
    };
    const doc = dissolveAppGroups(legacy, true);
    expect(doc.items.map((i) => i.kind)).toEqual(["app", "app"]);
    expect(doc.items.find((i) => i.id === "a")).toMatchObject({ folderId: null, cell: null });
    expect(fileCell(doc, "Araçlar")).toEqual({ col: 3, row: 2 });
    expect(dissolveAppGroups(legacy, false).files).toEqual([]);
    expect(dissolveAppGroups(doc, true)).toBe(doc);
    valid(doc);
  });

  it("arranges shortcuts and files by name, or folders first by kind", () => {
    const icons = [
      { ref: { kind: "app" as const, id: "a" }, name: "Sistem", group: 1 },
      { ref: { kind: "app" as const, id: "b" }, name: "Ayarlar", group: 1 },
      { ref: { kind: "file" as const, name: "Zeta" }, name: "Zeta", group: 0 },
      { ref: { kind: "file" as const, name: "Bütçe.ods" }, name: "Bütçe.ods", group: 2 },
    ];
    const byName = arrangeIcons(base(), icons, "name", metrics);
    expect(byName.items.find((i) => i.id === "b")!.cell).toEqual({ col: 0, row: 0 });
    expect(fileCell(byName, "Bütçe.ods")).toEqual({ col: 0, row: 1 });
    const byKind = arrangeIcons(base(), icons, "kind", metrics);
    expect(fileCell(byKind, "Zeta")).toEqual({ col: 0, row: 0 });
    expect(fileCell(byKind, "Bütçe.ods")).toEqual({ col: 0, row: 3 });
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
