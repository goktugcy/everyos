import { describe, expect, it } from "vitest";
import { iconsInRect, moveSelection, selectIcon, selectionRect } from "./icon-selection.ts";

const plain = { shiftKey: false, ctrlKey: false, metaKey: false };
const order = ["a", "b", "c", "d"];

describe("desktop selection", () => {
  it("replaces selection on a plain click and toggles with Ctrl or Command", () => {
    expect([...selectIcon(new Set(["a"]), "b", order, "a", plain)]).toEqual(["b"]);
    expect([...selectIcon(new Set(["a"]), "b", order, "a", { ...plain, ctrlKey: true })]).toEqual([
      "a",
      "b",
    ]);
    expect([
      ...selectIcon(new Set(["a", "b"]), "b", order, "a", { ...plain, metaKey: true }),
    ]).toEqual(["a"]);
  });

  it("extends a range in either direction and can add it to an existing selection", () => {
    expect([...selectIcon(new Set(["d"]), "a", order, "c", { ...plain, shiftKey: true })]).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect([
      ...selectIcon(new Set(["d"]), "a", order, "b", { ...plain, shiftKey: true, ctrlKey: true }),
    ]).toEqual(["d", "a", "b"]);
    expect([
      ...selectIcon(new Set(["d"]), "a", order, "missing", { ...plain, shiftKey: true }),
    ]).toEqual(["a"]);
  });

  it("selects intersecting icons when drawing in any direction, excluding edge-only contact", () => {
    const bounds = new Map([
      ["a", { x: 10, y: 10, width: 30, height: 40 }],
      ["b", { x: 45, y: 15, width: 20, height: 20 }],
      ["c", { x: 70, y: 20, width: 20, height: 20 }],
    ]);
    const rect = selectionRect({ x: 70, y: 60 }, { x: 20, y: 0 });
    expect([...iconsInRect(rect, bounds)]).toEqual(["a", "b"]);
    expect([...iconsInRect(selectionRect({ x: 20, y: 0 }, { x: 70, y: 60 }), bounds)]).toEqual([
      "a",
      "b",
    ]);
    expect(iconsInRect(selectionRect({ x: 20, y: 0 }, { x: 20, y: 60 }), bounds).size).toBe(0);
  });

  it("moves a group together, clamps at the edge and refuses occupied cells", () => {
    const placed = new Map([
      ["a", { col: 2, row: 1 }],
      ["b", { col: 3, row: 2 }],
      ["c", { col: 0, row: 0 }],
    ]);
    const metrics = {
      originX: 0,
      originY: 0,
      cellWidth: 100,
      cellHeight: 100,
      columns: 5,
      rows: 4,
    };
    expect(moveSelection(new Set(["a", "b"]), "a", { col: 4, row: 3 }, placed, metrics)).toEqual(
      new Map([
        ["a", { col: 3, row: 2 }],
        ["b", { col: 4, row: 3 }],
      ]),
    );
    expect(moveSelection(new Set(["a", "b"]), "a", { col: 0, row: 0 }, placed, metrics)).toBeNull();
    expect(
      moveSelection(new Set(["a"]), "missing", { col: 0, row: 0 }, placed, metrics),
    ).toBeNull();
  });
});
