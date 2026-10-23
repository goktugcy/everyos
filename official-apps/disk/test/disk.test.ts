import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  HISTORY_BYTES,
  MAX_SAMPLES,
  MAX_SCOPES,
  childPath,
  diskReport,
  folderKey,
  mountKey,
  parentPath,
  readHistory,
  readSettings,
  recordSample,
  safePath,
  trendPoints,
  usedPercent,
  type Trend,
} from "../src/disk.ts";
import { storage, usage } from "./fixture.ts";

describe("Disk Explorer data", () => {
  it("restores only bounded settings and paths relative to the shared folder", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ rootId: "a".repeat(65), path: "../private", tab: "__proto__" })).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(readSettings({ rootId: "shared", path: "media/films", tab: "volumes" })).toEqual({
      rootId: "shared",
      path: "media/films",
      tab: "volumes",
    });
    for (const path of [
      "/etc",
      "a/../b",
      "a//b",
      "./a",
      "a/",
      `a${String.fromCharCode(0)}b`,
      "a".repeat(4097),
    ])
      expect(safePath(path)).toBe(false);
    expect(childPath("media", "films")).toBe("media/films");
    for (const name of ["..", "/etc", "a/b", ""]) expect(childPath("media", name)).toBeNull();
    expect(parentPath("media/films")).toBe("media");
    expect(parentPath("")).toBe("");
    expect(childPath("", "写真")).toBe("写真");
  });

  it("rejects malformed saved observations and does not mix sources or duplicate scopes", () => {
    const valid = {
      key: "scope",
      source: "host",
      samples: [
        { at: 1, bytes: 2 },
        { at: 1, bytes: 9 },
        { at: 0, bytes: 3 },
        { at: 2, bytes: -1 },
        { at: 3, bytes: 0 },
        { at: 1e25, bytes: 1 },
      ],
    };
    expect(readHistory([null, {}, { ...valid, source: "invented" }, valid, valid])).toEqual([
      {
        key: "scope",
        source: "host",
        samples: [
          { at: 1, bytes: 2 },
          { at: 3, bytes: 0 },
        ],
      },
    ]);
    expect(readHistory("[]")).toEqual([]);
    expect(
      recordSample(readHistory([valid]), "scope", "simulated", { at: 100, bytes: 500 }),
    ).toEqual([{ key: "scope", source: "simulated", samples: [{ at: 100, bytes: 500 }] }]);
  });

  it("coalesces rapid refreshes, retains later measurements and fences a backwards clock", () => {
    let history = recordSample([], "scope", "host", { at: 1000, bytes: 2 });
    history = recordSample(history, "scope", "host", { at: 2000, bytes: 5 });
    expect(history[0]?.samples).toEqual([{ at: 2000, bytes: 5 }]);
    history = recordSample(history, "scope", "host", { at: 18000, bytes: 8 });
    expect(history[0]?.samples).toHaveLength(2);
    expect(recordSample(history, "scope", "host", { at: 0, bytes: 0 })).toEqual(history);
    expect(recordSample(history, "scope", "host", { at: 19000, bytes: NaN })).toEqual(history);
    expect(recordSample(history, "scope", "host", { at: 1e25, bytes: 1 })).toEqual(history);
  });

  it("bounds history by scope count, sample count and encoded bytes below app storage limits", () => {
    let history: Trend[] = [];
    for (let scope = 0; scope < 12; scope++)
      for (let sample = 0; sample < 30; sample++) {
        history = recordSample(history, String(scope), "host", {
          at: (scope * 30 + sample + 1) * 20000,
          bytes: sample,
        });
      }
    expect(history).toHaveLength(MAX_SCOPES);
    expect(history.every((value) => value.samples.length <= MAX_SAMPLES)).toBe(true);
    const raw = Array.from({ length: 8 }, (_, i) => ({
      key: String(i) + "\u0800".repeat(8000),
      source: "host",
      samples: [{ at: i, bytes: 1 }],
    }));
    expect(
      new TextEncoder().encode(JSON.stringify(readHistory(raw))).byteLength,
    ).toBeLessThanOrEqual(HISTORY_BYTES);
  });

  it("draws actual time intervals without fabricated points or non-finite coordinates", () => {
    expect(trendPoints([])).toBe("");
    expect(trendPoints([{ at: 1, bytes: 1 }])).toBe("");
    expect(
      trendPoints([
        { at: 1, bytes: 1 },
        { at: 1, bytes: 1 },
      ]),
    ).toBe("");
    expect(
      trendPoints([
        { at: 0, bytes: 0 },
        { at: 10, bytes: 100 },
        { at: 100, bytes: 50 },
      ]),
    ).toBe("8.00,112.00 66.40,8.00 592.00,60.00");
    expect(
      trendPoints([
        { at: 0, bytes: 0 },
        { at: 10, bytes: 0 },
      ]),
    ).toBe("8.00,60.00 592.00,60.00");
    expect(usedPercent(4, 0)).toBe(0);
    expect(usedPercent(20, 10)).toBe(100);
    expect(usedPercent(-1, 10)).toBe(0);
  });

  it("exports complete measured snapshots and only the histories belonging to visible scopes", () => {
    const folder = {
      rootId: "opaque-handle",
      name: "shared",
      path: "media",
      startedAt: 1,
      at: 2,
      value: { ...usage, truncated: true },
    };
    const observed = { at: 1, bytes: 2 };
    const history = [
      { key: folderKey(folder.rootId, folder.path), source: "host" as const, samples: [observed] },
      { key: mountKey("/dev/data", "/data"), source: "host" as const, samples: [observed] },
      { key: "unrelated-private-folder", source: "host" as const, samples: [observed] },
    ];
    const report = diskReport(
      folder,
      { at: 2, value: storage },
      [...history, { ...history[1]!, source: "simulated" }],
      1000,
    );
    expect(report.folder).toMatchObject({
      truncated: true,
      total: 1200,
      source: "host",
      measuredAt: 2,
    });
    expect(report.history).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("opaque-handle");
    expect(JSON.stringify(report)).not.toContain("unrelated-private-folder");
    expect(diskReport(null, null, history, 1000).history).toEqual([]);
  });
});
