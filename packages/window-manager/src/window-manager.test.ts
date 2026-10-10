import { WindowSessionSchema } from "@otuken/shared/schemas";
import { describe, expect, it } from "vitest";
import {
  clampBounds,
  createWindowManager,
  detectSnapZone,
  effectiveRect,
  layoutRect,
  MIN_VISIBLE_WIDTH,
  scaleBounds,
  snapRect,
  tileRects,
  TITLE_BAR_HEIGHT,
  visibleWindows,
  workArea,
  type Viewport,
  type WindowSpec,
} from "./index.ts";

const viewport: Viewport = {
  width: 1440,
  height: 900,
  insets: { top: 40, right: 0, bottom: 80, left: 0 },
};
const work = workArea(viewport);

const settings: WindowSpec = {
  appId: "otuken.settings",
  title: "Ayarlar",
  defaultSize: { width: 900, height: 640 },
  minSize: { width: 480, height: 360 },
  instancing: "single",
};
const folder: WindowSpec = {
  ...settings,
  appId: "otuken.folder",
  title: "Klasör",
  instancing: "multiple",
};

function manager() {
  let n = 0;
  return createWindowManager({ viewport, desktopId: "d1", createId: () => `w${++n}` });
}

describe("geometry", () => {
  it("computes the work area without menu bar and dock", () => {
    expect(work).toEqual({ x: 0, y: 40, width: 1440, height: 780 });
  });

  it("snaps to halves and quarters that cover the work area exactly", () => {
    expect(snapRect("left", work)).toEqual({ x: 0, y: 40, width: 720, height: 780 });
    expect(snapRect("right", work)).toEqual({ x: 720, y: 40, width: 720, height: 780 });
    expect(snapRect("bottom-right", work)).toEqual({ x: 720, y: 430, width: 720, height: 390 });
    expect(layoutRect("maximized", { x: 1, y: 1, width: 1, height: 1 }, viewport)).toEqual(work);
    expect(layoutRect("fullscreen", { x: 1, y: 1, width: 1, height: 1 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
    });
  });

  it("detects snap zones at the edges and corners", () => {
    expect(detectSnapZone({ x: 2, y: 400 }, viewport)).toBe("left");
    expect(detectSnapZone({ x: 1438, y: 400 }, viewport)).toBe("right");
    expect(detectSnapZone({ x: 2, y: 50 }, viewport)).toBe("top-left");
    expect(detectSnapZone({ x: 1438, y: 810 }, viewport)).toBe("bottom-right");
    expect(detectSnapZone({ x: 700, y: 45 }, viewport)).toBe("maximized");
    expect(detectSnapZone({ x: 700, y: 400 }, viewport)).toBeNull();
  });

  it("keeps the title bar of any window reachable", () => {
    for (const bounds of [
      { x: -5000, y: -5000, width: 800, height: 600 },
      { x: 5000, y: 5000, width: 800, height: 600 },
      { x: 100, y: 100, width: 9000, height: 9000 },
      { x: 100, y: 100, width: 10, height: 10 },
    ]) {
      const clamped = clampBounds(bounds, viewport, settings.minSize);
      expect(clamped.width).toBeLessThanOrEqual(work.width);
      expect(clamped.height).toBeLessThanOrEqual(work.height);
      expect(clamped.width).toBeGreaterThanOrEqual(settings.minSize.width);
      expect(clamped.y).toBeGreaterThanOrEqual(work.y);
      expect(clamped.y + TITLE_BAR_HEIGHT).toBeLessThanOrEqual(work.y + work.height);
      expect(clamped.x + clamped.width).toBeGreaterThanOrEqual(work.x + MIN_VISIBLE_WIDTH);
      expect(clamped.x).toBeLessThanOrEqual(work.x + work.width - MIN_VISIBLE_WIDTH);
    }
  });

  it("scales bounds proportionally between resolutions", () => {
    expect(
      scaleBounds(
        { x: 720, y: 450, width: 720, height: 450 },
        { width: 1440, height: 900 },
        { width: 720, height: 450 },
      ),
    ).toEqual({
      x: 360,
      y: 225,
      width: 360,
      height: 225,
    });
  });

  it("tiles windows without gaps or overlap", () => {
    const rects = tileRects(5, work, "grid");
    expect(rects).toHaveLength(5);
    const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    expect(area).toBeLessThanOrEqual(work.width * work.height);
    expect(
      tileRects(3, work, "columns")
        .map((r) => r.width)
        .reduce((a, b) => a + b),
    ).toBe(work.width);
  });
});

describe("window lifecycle", () => {
  it("opens, focuses and stacks windows", () => {
    const wm = manager();
    const a = wm.getState().open(folder);
    const b = wm.getState().open(folder);
    expect(wm.getState().focusedId).toBe(b);
    expect(wm.getState().windows[b]!.z).toBeGreaterThan(wm.getState().windows[a]!.z);
    expect(wm.getState().windows[b]!.bounds).not.toEqual(wm.getState().windows[a]!.bounds);
    wm.getState().focus(a);
    expect(wm.getState().focusedId).toBe(a);
    expect(visibleWindows(wm.getState()).map((w) => w.id)).toEqual([a, b]);
  });

  it("reuses single-instance apps and applies new app state", () => {
    const wm = manager();
    const first = wm.getState().open(settings, { appState: { section: "account" } });
    wm.getState().minimize(first);
    const again = wm.getState().open(settings, { appState: { section: "appearance" } });
    expect(again).toBe(first);
    expect(wm.getState().windows[first]).toMatchObject({
      minimized: false,
      appState: { section: "appearance" },
    });
    expect(Object.keys(wm.getState().windows)).toHaveLength(1);
  });

  it("moves focus to the next window when minimizing or closing", () => {
    const wm = manager();
    const a = wm.getState().open(folder);
    const b = wm.getState().open(folder);
    wm.getState().minimize(b);
    expect(wm.getState().focusedId).toBe(a);
    wm.getState().close(a);
    expect(wm.getState().focusedId).toBeNull();
    wm.getState().restore(b);
    expect(wm.getState().focusedId).toBe(b);
  });

  it("maximizes, snaps and restores the floating bounds", () => {
    const wm = manager();
    const id = wm.getState().open(settings);
    const floating = wm.getState().windows[id]!.bounds;
    wm.getState().toggleMaximize(id);
    expect(effectiveRect(wm.getState().windows[id]!, viewport)).toEqual(work);
    wm.getState().toggleMaximize(id);
    expect(effectiveRect(wm.getState().windows[id]!, viewport)).toEqual(floating);
    wm.getState().setLayout(id, "right");
    expect(effectiveRect(wm.getState().windows[id]!, viewport).x).toBe(720);
    wm.getState().setBounds(id, { x: 10, y: 60, width: 600, height: 400 });
    expect(wm.getState().windows[id]).toMatchObject({
      layout: "floating",
      bounds: { x: 10, y: 60, width: 600, height: 400 },
    });
  });

  it("clamps windows when the viewport shrinks", () => {
    const wm = manager();
    const id = wm.getState().open(settings);
    wm.getState().setBounds(id, { x: 1200, y: 700, width: 600, height: 400 });
    const small: Viewport = { width: 800, height: 600, insets: viewport.insets };
    wm.getState().setViewport(small);
    const bounds = wm.getState().windows[id]!.bounds;
    expect(bounds.x).toBeLessThanOrEqual(800 - MIN_VISIBLE_WIDTH);
    expect(bounds.y + TITLE_BAR_HEIGHT).toBeLessThanOrEqual(600 - viewport.insets.bottom);
  });

  it("keeps windows per virtual desktop", () => {
    const wm = manager();
    const a = wm.getState().open(folder);
    wm.getState().switchDesktop("d2");
    expect(wm.getState().focusedId).toBeNull();
    const b = wm.getState().open(folder);
    expect(wm.getState().windows[b]!.desktopId).toBe("d2");
    expect(visibleWindows(wm.getState()).map((w) => w.id)).toEqual([b]);
    wm.getState().focus(a);
    expect(wm.getState().activeDesktopId).toBe("d1");
    wm.getState().mergeDesktop("d2", "d1");
    expect(wm.getState().windows[b]!.desktopId).toBe("d1");
  });

  it("cycles through windows in both directions", () => {
    const wm = manager();
    const a = wm.getState().open(folder);
    const b = wm.getState().open(folder);
    const c = wm.getState().open(folder);
    wm.getState().cycle(1);
    expect(wm.getState().focusedId).toBe(a);
    wm.getState().cycle(-1);
    expect(wm.getState().focusedId).toBe(c);
    expect(visibleWindows(wm.getState())[0]!.id).toBe(c);
    expect(b).toBeDefined();
  });

  it("tiles and minimizes all windows of the active desktop", () => {
    const wm = manager();
    for (let i = 0; i < 4; i++) wm.getState().open(folder);
    wm.getState().tile("grid");
    const rects = visibleWindows(wm.getState()).map((w) => w.bounds);
    expect(new Set(rects.map((r) => `${r.x},${r.y}`)).size).toBe(4);
    wm.getState().minimizeAll();
    expect(visibleWindows(wm.getState())).toEqual([]);
  });
});

describe("persistence", () => {
  it("serializes to a valid session and restores it on another screen", () => {
    const wm = manager();
    const a = wm.getState().open(settings, { appState: { section: "appearance" } });
    const b = wm.getState().open(folder);
    wm.getState().setLayout(b, "left");
    wm.getState().cycle(-1);
    const session = wm.getState().serialize();
    expect(WindowSessionSchema.safeParse(session).success).toBe(true);
    expect(session.windows.map((w) => w.z).sort()).toEqual([1, 2]);

    const laptop = createWindowManager({
      viewport: { width: 1280, height: 720, insets: viewport.insets },
      desktopId: "d1",
    });
    laptop
      .getState()
      .hydrate(session, (appId) =>
        appId === settings.appId ? settings : appId === folder.appId ? folder : null,
      );
    const restored = laptop.getState();
    expect(Object.keys(restored.windows).sort()).toEqual([a, b].sort());
    expect(restored.windows[a]!.appState).toEqual({ section: "appearance" });
    expect(restored.windows[b]!.layout).toBe("left");
    for (const window of Object.values(restored.windows)) {
      expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(
        1280 + window.bounds.width - MIN_VISIBLE_WIDTH,
      );
      expect(window.bounds.width).toBeLessThanOrEqual(1280);
    }
  });

  it("drops windows of apps that no longer exist or are not permitted", () => {
    const wm = manager();
    wm.getState().open(settings);
    wm.getState().open(folder);
    const session = wm.getState().serialize();
    const restored = manager();
    restored.getState().hydrate(session, (appId) => (appId === folder.appId ? folder : null));
    expect(Object.values(restored.getState().windows).map((w) => w.appId)).toEqual([
      "otuken.folder",
    ]);
  });
});
