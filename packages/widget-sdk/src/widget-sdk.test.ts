import { WidgetManifestSchema, WidgetPreferencesSchema } from "@otuken/shared/schemas";
import { PERMISSIONS, type WidgetPreferences } from "@otuken/shared";
import { describe, expect, it } from "vitest";
import {
  addWidget,
  BUILT_IN_WIDGETS,
  changePlacement,
  defaultConfig,
  defaultWidgetPreferences,
  detectAdapters,
  duplicateWidget,
  EMPTY_WIDGETS,
  getWidget,
  LayoutError,
  migrateInstance,
  migrateWidgets,
  missingConfig,
  reassignDesktops,
  moveWidget,
  normalizeConfig,
  ordered,
  reorderWidget,
  repositoryOf,
  resizeWidget,
  resolveTopics,
  sizesFor,
  updateWidget,
  widgetAvailability,
  widgetKey,
} from "./index.ts";

const grid = { columns: 12, rows: 8 };
let counter = 0;
const id = () => `w${++counter}`;
const widget = (wid: string) => getWidget(wid)!;

describe("built-in manifests", () => {
  it("are valid, unique and internally consistent", () => {
    const ids = new Set<string>();
    for (const manifest of BUILT_IN_WIDGETS) {
      expect(WidgetManifestSchema.safeParse(manifest).success, manifest.id).toBe(true);
      expect(ids.has(manifest.id), manifest.id).toBe(false);
      ids.add(manifest.id);
      expect(manifest.supportedSizes, manifest.id).toContain(manifest.defaultSize);
      // Every placement must offer at least one size.
      for (const placement of manifest.placements)
        expect(sizesFor(manifest, placement).length, `${manifest.id}/${placement}`).toBeGreaterThan(
          0,
        );
      // App widgets always go through a configured integration.
      if (manifest.categories.includes("apps"))
        expect(
          manifest.config.some((field) => field.type === "integration"),
          manifest.id,
        ).toBe(true);
    }
    expect(BUILT_IN_WIDGETS.length).toBeGreaterThan(40);
    expect(widgetKey("system.cpuFrequency")).toBe("system_cpuFrequency");
  });

  it("covers every adapter declared in the contract", () => {
    for (const adapter of [
      "jellyfin",
      "immich",
      "homeassistant",
      "uptimekuma",
      "nextcloud",
      "postgresql",
    ]) {
      expect(
        BUILT_IN_WIDGETS.some((m) => m.provider === adapter),
        adapter,
      ).toBe(true);
    }
  });
});

describe("configuration", () => {
  it("normalizes values against the manifest", () => {
    const processes = widget("system.processes");
    expect(defaultConfig(processes)).toEqual({ sort: "cpu", count: 5 });
    expect(normalizeConfig(processes, { sort: "name", count: 99, extra: "x" })).toEqual({
      sort: "cpu",
      count: 10,
    });
    const entities = widget("homeassistant.controls");
    expect(
      normalizeConfig(entities, {
        integration: "not-a-uuid",
        entities: ["switch.kettle", "switch.kettle", "bad id", 4],
      }),
    ).toEqual({ integration: "", entities: ["switch.kettle"] });
    expect(missingConfig(entities, defaultConfig(entities))).toEqual(["integration", "entities"]);
    expect(normalizeConfig(widget("docker.app"), { target: "container:jellyfin" })).toEqual({
      target: "container:jellyfin",
    });
    expect(normalizeConfig(widget("docker.app"), { target: "container:../x" })).toEqual({
      target: "",
    });
  });

  it("migrates instances written for an older manifest version", () => {
    const manifest = widget("system.processes");
    const old = {
      ...addWidget(EMPTY_WIDGETS, manifest, {
        id: id(),
        placement: "sidebar",
        desktopId: null,
        grid,
      }).instances[0]!,
      widgetVersion: 0,
      config: { count: 50 },
    };
    expect(migrateInstance(old, manifest)).toMatchObject({
      widgetVersion: manifest.version,
      config: { sort: "cpu", count: 10 },
    });
  });

  it("resolves integration topics only once configured", () => {
    const manifest = widget("jellyfin.sessions");
    expect(resolveTopics(manifest, { integration: "" })).toEqual([]);
    const integration = "0b5a3a5e-1d2c-4b8a-9f00-0123456789ab";
    expect(resolveTopics(manifest, { integration })).toEqual([
      `data.integration.${integration}.sessions`,
    ]);
    expect(resolveTopics(widget("docker.resources"), {})).toEqual(["docker", "data.docker"]);
  });
});

describe("compatibility", () => {
  it("requires every permission and the host capability", () => {
    const viewer = ["system:read", "services:read", "docker:read", "apps:read"] as const;
    expect(
      widgetAvailability(widget("system.cpu"), { permissions: viewer, capabilities: null }),
    ).toEqual({ ok: true });
    expect(
      widgetAvailability(widget("homeassistant.controls"), {
        permissions: viewer,
        capabilities: null,
      }),
    ).toEqual({
      ok: false,
      reason: "permission",
    });
    expect(
      widgetAvailability(widget("raspberryPi.throttling"), {
        permissions: viewer,
        capabilities: { raspberryPi: { available: false, reason: "unsupported-hardware" } },
      }),
    ).toMatchObject({ ok: false, reason: "capability", capability: "raspberryPi" });
  });

  it("offers compact widgets in the menu bar and panel sizes elsewhere", () => {
    expect(sizesFor(widget("system.cpu"), "menubar")).toEqual(["compact"]);
    expect(sizesFor(widget("system.cpu"), "sidebar")).toEqual(["small", "medium", "large"]);
    expect(sizesFor(widget("system.cpu"), "desktop")).toEqual([
      "small",
      "medium",
      "large",
      "custom",
    ]);
    expect(sizesFor(widget("system.processes"), "menubar")).toEqual([]);
  });
});

describe("app adapter detection", () => {
  it("derives adapters from image references", () => {
    expect(repositoryOf("lscr.io/linuxserver/jellyfin:10.11.0@sha256:abc")).toBe(
      "linuxserver/jellyfin",
    );
    expect(repositoryOf("postgres:17-alpine")).toBe("postgres");
    expect(repositoryOf("docker.io/library/nextcloud:31")).toBe("nextcloud");
    expect(repositoryOf("localhost:5000/team/app:1")).toBe("team/app");
    expect(
      detectAdapters([
        "ghcr.io/immich-app/immich-server:v2",
        "ghcr.io/immich-app/postgres:14",
        "redis:7",
      ]),
    ).toEqual(["immich", "postgresql"]);
    expect(detectAdapters(["ghcr.io/home-assistant/home-assistant:stable"])).toEqual([
      "homeassistant",
    ]);
    expect(detectAdapters(["louislam/uptime-kuma:2"])).toEqual(["uptimekuma"]);
    // Look-alike names do not match.
    expect(detectAdapters(["evil/jellyfin-stealer", "nextcloud-exporter"])).toEqual([]);
  });
});

describe("layout operations", () => {
  const cpu = widget("system.cpu");

  it("places desktop widgets from the top-right without overlaps", () => {
    let doc: WidgetPreferences = EMPTY_WIDGETS;
    doc = addWidget(doc, cpu, { id: "a", placement: "desktop", desktopId: "d1", grid });
    doc = addWidget(doc, cpu, { id: "b", placement: "desktop", desktopId: "d1", grid });
    doc = addWidget(doc, cpu, { id: "c", placement: "desktop", desktopId: "d2", grid });
    expect(doc.instances.map((i) => [i.id, i.position])).toEqual([
      ["a", { col: 10, row: 0 }],
      ["b", { col: 10, row: 2 }],
      // Another desktop has its own free space.
      ["c", { col: 10, row: 0 }],
    ]);
    expect(WidgetPreferencesSchema.safeParse(doc).success).toBe(true);
    // Moving onto another widget or off the grid is refused.
    expect(moveWidget(doc, "b", { col: 10, row: 1 }, grid)).toBe(doc);
    expect(moveWidget(doc, "b", { col: 11, row: 0 }, grid)).toBe(doc);
    expect(moveWidget(doc, "b", { col: 0, row: 0 }, grid).instances[1]!.position).toEqual({
      col: 0,
      row: 0,
    });
  });

  it("respects locks, sizes and the grid when resizing", () => {
    let doc = addWidget(EMPTY_WIDGETS, cpu, {
      id: "a",
      placement: "desktop",
      desktopId: "d1",
      grid,
    });
    doc = resizeWidget(doc, "a", "custom", { w: 3, h: 3 }, grid);
    // Custom sizes may not cross the grid edge.
    expect(doc.instances[0]!.size).toBe("small");
    doc = moveWidget(doc, "a", { col: 0, row: 0 }, grid);
    doc = resizeWidget(doc, "a", "custom", { w: 3.4, h: 20 }, grid);
    expect(doc.instances[0]).toMatchObject({ size: "small" });
    doc = resizeWidget(doc, "a", "custom", { w: 3.4, h: 5 }, grid);
    expect(doc.instances[0]).toMatchObject({ size: "custom", custom: { w: 3, h: 5 } });
    doc = updateWidget(doc, "a", { locked: true, opacity: 0.1 });
    expect(doc.instances[0]!.opacity).toBe(0.3);
    expect(moveWidget(doc, "a", { col: 5, row: 0 }, grid)).toBe(doc);
    expect(resizeWidget(doc, "a", "small", null, grid)).toBe(doc);
  });

  it("duplicates, reorders and moves widgets between placements", () => {
    let doc = addWidget(EMPTY_WIDGETS, cpu, {
      id: "a",
      placement: "sidebar",
      desktopId: null,
      grid,
    });
    doc = addWidget(doc, widget("system.memory"), {
      id: "b",
      placement: "sidebar",
      desktopId: null,
      grid,
    });
    doc = duplicateWidget(doc, "a", "c", grid);
    expect(ordered(doc, "sidebar").map((i) => i.id)).toEqual(["a", "b", "c"]);
    doc = reorderWidget(doc, "c", -1);
    expect(ordered(doc, "sidebar").map((i) => i.id)).toEqual(["a", "c", "b"]);
    doc = changePlacement(doc, "b", "menubar", null, grid);
    expect(doc.instances.find((i) => i.id === "b")).toMatchObject({
      placement: "menubar",
      size: "compact",
    });
    doc = changePlacement(doc, "b", "desktop", "d1", grid);
    expect(doc.instances.find((i) => i.id === "b")).toMatchObject({
      placement: "desktop",
      size: "small",
      position: { col: 10, row: 0 },
    });
    expect(() => changePlacement(doc, "a", "menubar", null, grid)).not.toThrow();
    const processes = addWidget(doc, widget("system.processes"), {
      id: "p",
      placement: "sidebar",
      desktopId: null,
      grid,
    });
    expect(() => changePlacement(processes, "p", "menubar", null, grid)).toThrow(LayoutError);
  });

  it("reports a full desktop instead of overlapping", () => {
    const tiny = { columns: 2, rows: 2 };
    const doc = addWidget(EMPTY_WIDGETS, cpu, {
      id: "a",
      placement: "desktop",
      desktopId: "d1",
      grid: tiny,
    });
    expect(() =>
      addWidget(doc, cpu, { id: "b", placement: "desktop", desktopId: "d1", grid: tiny }),
    ).toThrow(expect.objectContaining({ reason: "no-space" }));
  });

  it("restores a permission-aware default layout", () => {
    const all = defaultWidgetPreferences(PERMISSIONS, id);
    expect(all.instances.map((i) => [i.widgetId, i.placement])).toEqual([
      ["system.cpu", "sidebar"],
      ["system.memory", "sidebar"],
      ["system.network", "sidebar"],
      ["system.diskUsage", "sidebar"],
    ]);
    expect(defaultWidgetPreferences([], id).instances).toEqual([]);
    expect(WidgetPreferencesSchema.safeParse(all).success).toBe(true);
  });

  it("migrates stored layouts to current manifest versions and keeps unknown widgets", () => {
    const stored: WidgetPreferences = {
      version: 1,
      sidebar: { open: false },
      instances: [
        {
          ...defaultWidgetPreferences(PERMISSIONS, id).instances[0]!,
          id: "old",
          widgetVersion: 0,
          config: { chart: "yes", legacy: 1 },
        },
        {
          ...defaultWidgetPreferences(PERMISSIONS, id).instances[0]!,
          id: "gone",
          widgetId: "removed.widget",
          widgetVersion: 3,
        },
      ],
    };
    const migrated = migrateWidgets(stored);
    expect(migrated.instances[0]).toMatchObject({ widgetVersion: 1, config: { chart: true } });
    expect(migrated.instances[0]!.config).not.toHaveProperty("legacy");
    expect(migrated.instances[1]).toBe(stored.instances[1]);
    expect(migrateWidgets(migrated)).toBe(migrated);
  });

  it("moves widgets of missing desktops to the first desktop", () => {
    const grid = { columns: 12, rows: 8 };
    let doc = addWidget(EMPTY_WIDGETS, cpu, {
      id: "a",
      placement: "desktop",
      desktopId: "gone",
      grid,
    });
    doc = addWidget(doc, cpu, { id: "b", placement: "desktop", desktopId: "d2", grid });
    const moved = reassignDesktops(doc, ["d1", "d2"]);
    expect(moved.instances.map((i) => i.desktopId)).toEqual(["d1", "d2"]);
    expect(reassignDesktops(moved, ["d1", "d2"])).toBe(moved);
  });
});
