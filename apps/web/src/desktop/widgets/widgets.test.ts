import { resources } from "@otuken/i18n";
import type { TopicMessage, WidgetInstance } from "@otuken/shared";
import { BUILT_IN_WIDGETS, widgetKey } from "@otuken/widget-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeTopic, type TopicHandlers } from "../../lib/event-stream.ts";
import { effectiveCells, visibleCell } from "./geometry.ts";
import { resolveDockerTarget, type DockerData } from "./renderers/docker.tsx";
import { WIDGET_RENDERERS } from "./renderers/index.ts";
import { acquireTopic, releaseTopic, useTopicStore } from "./topics.ts";

vi.mock("../../lib/event-stream.ts", () => ({ subscribeTopic: vi.fn() }));
vi.mock("../../stores/session-store.ts", () => ({
  usePermissions: vi.fn(() => []),
  useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(), subscribe: vi.fn() }),
}));
vi.mock("../state/window-store.ts", () => ({
  wm: vi.fn(),
  useWindowManager: vi.fn(),
  dockThickness: () => 0,
  MENUBAR_HEIGHT: 36,
  WIDGET_SIDEBAR_WIDTH: 320,
}));
vi.mock("../theme/theme-store.ts", () => ({ applyAppearance: vi.fn(), useThemeStore: vi.fn() }));

const subscribe = vi.mocked(subscribeTopic);

describe("built-in widget catalogue", () => {
  it("has a renderer for every manifest and nothing else", () => {
    expect(Object.keys(WIDGET_RENDERERS).sort()).toEqual(BUILT_IN_WIDGETS.map((m) => m.id).sort());
  });

  it("has a title and description in every locale", () => {
    for (const manifest of BUILT_IN_WIDGETS) {
      for (const locale of ["tr", "en"] as const) {
        const items = resources[locale].widgets.items as Record<
          string,
          { title: string; description: string }
        >;
        expect(items[widgetKey(manifest.id)]?.title, `${locale} ${manifest.id}`).toBeTruthy();
        expect(items[widgetKey(manifest.id)]?.description, `${locale} ${manifest.id}`).toBeTruthy();
      }
    }
  });
});

describe("topic subscriptions", () => {
  beforeEach(() => {
    subscribe.mockReset();
    useTopicStore.setState({}, true);
  });

  it("shares one stream subscription per topic and drops the cache with the last reader", () => {
    const unsubscribe = vi.fn();
    let handlers: TopicHandlers | undefined;
    subscribe.mockImplementation((_topic, next) => {
      handlers = next;
      return unsubscribe;
    });

    acquireTopic("data.storage");
    acquireTopic("data.storage");
    expect(subscribe).toHaveBeenCalledTimes(1);

    const message: TopicMessage = {
      topic: "data.storage",
      at: 1,
      status: "ok",
      data: { mounts: [] },
    };
    handlers?.data?.(message);
    expect(useTopicStore.getState()["data.storage"]).toEqual({
      status: "ok",
      data: { mounts: [] },
      at: 1,
    });

    releaseTopic("data.storage");
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseTopic("data.storage");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(useTopicStore.getState()["data.storage"]).toBeUndefined();
  });

  it("keeps unavailable reasons instead of data", () => {
    let handlers: TopicHandlers | undefined;
    subscribe.mockImplementation((_topic, next) => {
      handlers = next;
      return () => undefined;
    });
    acquireTopic("data.apt");
    handlers?.data?.({ topic: "data.apt", at: 2, status: "unavailable", reason: "tool-missing" });
    expect(useTopicStore.getState()["data.apt"]).toEqual({
      status: "unavailable",
      reason: "tool-missing",
    });
    releaseTopic("data.apt");
  });
});

describe("docker targets", () => {
  const data: DockerData = {
    source: "simulated",
    containers: [
      {
        id: "1",
        name: "jellyfin",
        image: "jellyfin/jellyfin",
        state: "running",
        health: "healthy",
        status: "Up",
        project: "media",
      },
      {
        id: "2",
        name: "db",
        image: "postgres:16",
        state: "exited",
        health: "none",
        status: "Exited",
        project: "media",
      },
      {
        id: "3",
        name: "solo",
        image: "nginx",
        state: "running",
        health: "none",
        status: "Up",
        project: null,
      },
    ],
    apps: [{ id: "a1", name: { en: "Media" }, project: "media" }],
  };

  it("resolves apps, projects and containers", () => {
    expect(resolveDockerTarget("app:a1", data).containers.map((c) => c.name)).toEqual([
      "jellyfin",
      "db",
    ]);
    expect(resolveDockerTarget("project:media", data).containers).toHaveLength(2);
    expect(resolveDockerTarget("container:solo", data).containers.map((c) => c.id)).toEqual(["3"]);
  });

  it("reports an uninstalled app instead of showing nothing", () => {
    const resolved = resolveDockerTarget("app:gone", data);
    expect(resolved.missingApp).toBe(true);
    expect(resolved.containers).toEqual([]);
  });
});

describe("desktop placement", () => {
  const instance = (col: number, row: number): WidgetInstance => ({
    id: "w",
    widgetId: "system.cpu",
    widgetVersion: 1,
    placement: "desktop",
    size: "medium",
    custom: null,
    position: { col, row },
    desktopId: null,
    order: 0,
    opacity: 1,
    locked: false,
    config: {},
  });
  const grid = { columns: 10, rows: 6, originX: 0, originY: 36 };

  it("never stacks widgets when a narrower work area pushes them inward", () => {
    const wide = { ...instance(14, 2), id: "docker", size: "small" as const };
    const cpu = { ...instance(6, 1), id: "cpu", size: "custom" as const, custom: { w: 5, h: 2 } };
    const narrow = { columns: 12, rows: 6, originX: 0, originY: 36 };
    const cells = effectiveCells([wide, cpu], narrow);
    // The CPU widget still fits where it was saved; the other one moves next to it.
    expect(cells.get("cpu")).toEqual({ col: 6, row: 1 });
    const docker = cells.get("docker")!;
    const overlap =
      docker.col < 6 + 5 && 6 < docker.col + 2 && docker.row < 1 + 2 && 1 < docker.row + 2;
    expect(overlap).toBe(false);
  });

  it("keeps widgets inside a narrower work area without changing the saved position", () => {
    expect(visibleCell(instance(8, 1), grid)).toEqual({ col: 6, row: 1 });
    expect(visibleCell(instance(2, 9), grid)).toEqual({ col: 2, row: 4 });
    expect(visibleCell(instance(1, 1), grid)).toEqual({ col: 1, row: 1 });
  });
});
