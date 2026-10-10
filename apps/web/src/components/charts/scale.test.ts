import { describe, expect, it } from "vitest";
import { linePaths, nearestIndex, niceTicks } from "./scale.ts";

describe("chart scales", () => {
  it("produces clean ticks", () => {
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(7_300_000)).toEqual([0, 2_000_000, 4_000_000, 6_000_000, 8_000_000]);
    expect(niceTicks(0)).toEqual([0, 1]);
    const gib = 1024 ** 3;
    expect(niceTicks(16 * gib, 4, 1024)).toEqual([0, 5, 10, 15, 20].map((n) => n * gib));
    expect(niceTicks(3 * 1024 ** 2, 4, 1024)).toEqual([0, 1, 2, 3].map((n) => n * 1024 ** 2));
  });

  it("finds the nearest sample", () => {
    expect(nearestIndex([0, 10, 20, 30], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20, 30], 16)).toBe(2);
    expect(nearestIndex([0, 10, 20, 30], 99)).toBe(3);
  });

  it("breaks lines at missing values and long gaps", () => {
    const identity = (v: number) => v;
    const segments = linePaths([0, 1, 2, 3, 10, 11], [1, 2, null, 4, 5, 6], identity, identity, 5);
    expect(segments.map((s) => [s.first, s.last])).toEqual([
      [0, 1],
      [3, 3],
      [4, 5],
    ]);
    expect(segments[0]!.line).toBe("M0.0,1.0L1.0,2.0");
  });
});
