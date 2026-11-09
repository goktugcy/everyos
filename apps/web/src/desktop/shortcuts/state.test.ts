import type { CustomShortcut, Permission } from "@everyos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api.ts";
import type * as ApiModule from "../../lib/api.ts";
import { appTitle } from "../apps/app-title.ts";
import { getApp } from "../apps/registry.ts";
import { uninstallDesktopApp } from "../desktop-apps/uninstall.ts";
import { desktop, resolveSpec } from "../state/controller.ts";
import {
  discardPending,
  flushPending,
  loadPreferences,
  updatePreference,
  usePreferences,
} from "../state/preferences-store.ts";
import type { LoadContext } from "../state/preferences-store.ts";
import { saveCustomShortcut } from "./state.ts";

const session = vi.hoisted(() => ({ permissions: ["preferences:manage"] as Permission[] }));
const openWindow = vi.hoisted(() => vi.fn(() => "real-window"));
vi.mock("../../lib/api.ts", async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock("../theme/theme-store.ts", () => ({ applyAppearance: vi.fn() }));
vi.mock("../../stores/session-store.ts", () => ({
  useSessionStore: {
    getState: () => ({ session: { permissions: session.permissions, session: { id: "test" } } }),
  },
}));
vi.mock("../state/window-store.ts", () => ({ wm: () => ({ open: openWindow, windows: {} }) }));
const entry: CustomShortcut = {
  id: "everyos.shortcut.link-test",
  name: "My console",
  icon: null,
  source: "manual",
  permission: null,
  target: { kind: "url", url: "https://server.example/ui" },
};
const placement = {
  editing: false,
  desktop: true,
  dock: true,
  desktopId: "d1",
  metrics: { originX: 0, originY: 36, cellWidth: 96, cellHeight: 106, columns: 12, rows: 6 },
};
const context: LoadContext = {
  t: ((key: string) => key) as LoadContext["t"],
  permissions: ["preferences:manage"],
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  discardPending();
  usePreferences.setState({
    ready: false,
    saveError: false,
    desktop: {
      version: 1,
      desktops: [{ id: "d1", name: "", wallpaper: null }],
      items: [],
      files: [],
    },
    dock: { ...usePreferences.getState().dock, pinned: [] },
  });
  session.permissions = ["preferences:manage"];
  vi.mocked(api).mockResolvedValue(undefined);
});
afterEach(() => {
  discardPending();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared custom shortcuts", () => {
  it("removes custom aliases after a confirmed app uninstall without deleting manual links", async () => {
    saveCustomShortcut(
      {
        ...entry,
        source: "official",
        target: { kind: "app", appId: "everyos.desktop.dev.everyos.calculator" },
      },
      placement,
    );
    const manual = { ...entry, id: "everyos.shortcut.link-manual" };
    saveCustomShortcut(manual, placement);
    await uninstallDesktopApp("dev.everyos.calculator");
    expect(api).toHaveBeenCalledWith("/desktop-apps/installed/dev.everyos.calculator", {
      method: "DELETE",
      body: { confirm: true },
    });
    expect(usePreferences.getState().shortcuts.entries).toEqual([manual]);
    expect(usePreferences.getState().dock.pinned).toEqual([manual.id]);
    expect(usePreferences.getState().desktop.items).toHaveLength(1);
  });
  it("updates both placements immediately, persists and retains the shared record until the last removal", async () => {
    expect(saveCustomShortcut(entry, placement)).toBe(true);
    expect(usePreferences.getState().dock.pinned).toEqual([entry.id]);
    expect(usePreferences.getState().desktop.items[0]).toMatchObject({
      kind: "app",
      appId: entry.id,
    });
    expect(saveCustomShortcut({ ...entry, id: "everyos.shortcut.link-duplicate" }, placement)).toBe(
      true,
    );
    expect(usePreferences.getState().shortcuts.entries).toHaveLength(1);
    expect(usePreferences.getState().desktop.items).toHaveLength(1);
    const edited = { ...entry, name: "Renamed", icon: "https://images.example/icon.png" };
    expect(saveCustomShortcut(edited, { ...placement, editing: true })).toBe(true);
    expect(getApp(entry.id)?.shortcut).toEqual(edited);
    expect(appTitle(getApp(entry.id)!, context.t)).toBe("Renamed");
    await flushPending();
    expect(api).toHaveBeenCalledWith(
      "/preferences/shortcuts",
      expect.objectContaining({ body: { version: 1, entries: [edited] } }),
    );
    updatePreference("desktop", (doc) => ({ ...doc, items: [] }));
    expect(getApp(entry.id)).toBeDefined();
    updatePreference("dock", (doc) => ({ ...doc, pinned: [] }));
    expect(getApp(entry.id)).toBeUndefined();
    await flushPending();
    expect(api).toHaveBeenLastCalledWith("/preferences/dock", expect.anything());
    expect(usePreferences.getState().shortcuts.entries).toEqual([]);
  });
  it("opens safe links without a phantom window, and delegates native apps to their real identity and permissions", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    saveCustomShortcut(entry, placement);
    desktop.openApp(entry.id as `everyos.shortcut.link-${string}`);
    expect(open).toHaveBeenCalledWith("https://server.example/ui", "_blank", "noopener,noreferrer");
    expect(openWindow).not.toHaveBeenCalled();
    expect(resolveSpec(entry.id)).toBeNull();
    saveCustomShortcut(
      { ...entry, source: "official", target: { kind: "app", appId: "everyos.docker" } },
      { ...placement, editing: true },
    );
    session.permissions = ["docker:read"];
    expect(desktop.openApp(entry.id as `everyos.shortcut.link-${string}`)).toBe("real-window");
    expect(openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "everyos.docker" }),
      {},
    );
    session.permissions = [];
    openWindow.mockClear();
    expect(desktop.openApp(entry.id as `everyos.shortcut.link-${string}`)).toBeNull();
    expect(openWindow).not.toHaveBeenCalled();
  });
  it("loads legacy preferences with empty shortcuts and clears private links on sign-out", async () => {
    saveCustomShortcut(entry, placement);
    vi.mocked(api).mockResolvedValue({ preferences: {} });
    await loadPreferences(context);
    expect(usePreferences.getState().shortcuts.entries).toEqual([]);
    saveCustomShortcut(entry, placement);
    discardPending();
    expect(getApp(entry.id)).toBeUndefined();
  });
  it("refuses a new dock placement at its limit without creating an orphan record", () => {
    usePreferences.setState({
      dock: {
        ...usePreferences.getState().dock,
        pinned: Array.from({ length: 32 }, (_, i) => `everyos.test-${i}`),
      },
    });
    expect(saveCustomShortcut(entry, placement)).toBe(false);
    expect(usePreferences.getState().shortcuts.entries).toEqual([]);
    expect(usePreferences.getState().desktop.items).toEqual([]);
  });
});
