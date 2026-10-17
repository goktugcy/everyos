import type { ShelfItem } from "@everyos/shared";
import { describe, expect, it } from "vitest";
import { numberedName } from "../apps/files/lib.ts";
import {
  arrowDots,
  transferDots,
  dayKey,
  graphColumns,
  firstDayOfWeek,
  gridRange,
  monthGrid,
  readFilesDrag,
  shelfAdd,
  shelfRemove,
} from "./pulse-lib.ts";

const item = (path: string, addedAt = 1): ShelfItem => ({
  root: "dev",
  path,
  kind: "file",
  size: 1,
  addedAt,
});

describe("pulse calendar", () => {
  it("lays out six weeks starting on the locale's first weekday", () => {
    // October 2026 starts on a Thursday.
    const monday = monthGrid(2026, 9, 1);
    expect(monday).toHaveLength(42);
    expect(monday[0]!.key).toBe("2026-09-28");
    expect(monday[3]).toMatchObject({ key: "2026-10-01", inMonth: true });
    expect(monday.filter((cell) => cell.inMonth)).toHaveLength(31);
    const sunday = monthGrid(2026, 9, 0);
    expect(sunday[0]!.key).toBe("2026-09-27");
    expect(gridRange(monday)).toEqual({
      from: new Date(2026, 8, 28).getTime(),
      to: new Date(2026, 10, 9).getTime(),
    });
  });

  it("knows Turkish weeks start on Monday", () => {
    expect(firstDayOfWeek("tr")).toBe(1);
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("pulse shelf", () => {
  it("adds newest first without duplicates and removes by location", () => {
    const shelf = shelfAdd([item("a.txt"), item("b.txt")], [item("c.txt", 2), item("a.txt", 2)]);
    expect(shelf.map((entry) => entry.path)).toEqual(["c.txt", "a.txt", "b.txt"]);
    expect(shelf[1]!.addedAt).toBe(2);
    expect(shelfRemove(shelf, { root: "dev", path: "a.txt" }).map((e) => e.path)).toEqual([
      "c.txt",
      "b.txt",
    ]);
    const many = shelfAdd(
      [],
      Array.from({ length: 60 }, (_, index) => item(`f${index}`)),
    );
    expect(many).toHaveLength(48);
  });

  it("numbers taken upload names and reads only well-formed drags", () => {
    expect(numberedName("rapor.pdf", 1)).toBe("rapor.pdf");
    expect(numberedName("rapor.pdf", 2)).toBe("rapor (2).pdf");
    expect(numberedName(".env", 3)).toBe(".env (3)");
    expect(numberedName("README", 2)).toBe("README (2)");
    expect(readFilesDrag('{"root":"dev","paths":["a/b"]}')).toEqual({
      root: "dev",
      paths: ["a/b"],
    });
    expect(readFilesDrag('{"root":"dev","paths":[""]}')).toBeNull();
    expect(readFilesDrag("not json")).toBeNull();
  });
});

describe("pulse dot matrix", () => {
  it("draws CPU history as columns, newest on the right", () => {
    const columns = graphColumns([0, 0.5, 3, 50, 100, 140], 8, 5);
    expect(columns).toEqual([0, 0, 0, 0, 1, 3, 5, 5]);
    expect(graphColumns([], 4, 5)).toEqual([0, 0, 0, 0]);
    expect(
      graphColumns(
        Array.from({ length: 50 }, () => 40),
        34,
        5,
      ),
    ).toHaveLength(34);
  });

  it("places three arrows inside the matrix", () => {
    const dots = arrowDots(34, 5);
    expect(dots.size).toBe(27);
    for (const key of dots) {
      const [col, row] = key.split(":").map(Number) as [number, number];
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(34);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(5);
    }
  });
});

describe("transfer frames", () => {
  it("fills the bottom two rows from the left, with a blinking leading edge", () => {
    const half = transferDots(0.5);
    expect(half.size).toBe(17 * 2);
    expect(half.get("16:3")).toBe("head");
    expect(half.get("16:4")).toBe("head");
    expect(half.get("0:2")).toBeUndefined();
    expect(transferDots(0.001).size).toBe(2);
    // Finished bars have no leading edge; unknown totals draw nothing (the sweep shows activity).
    expect([...transferDots(1).values()].includes("head")).toBe(false);
    expect(transferDots(1).size).toBe(34 * 2);
    expect(transferDots(null).size).toBe(0);
  });
});
