import { PERMISSIONS, SUPPORTED_LOCALES } from "@everyos/shared";
import { describe, expect, it } from "vitest";
import {
  APP_CAPABILITIES,
  APP_LOCALES,
  CAPABILITY_INFO,
  appBelongsTo,
  capabilityInfo,
  checkCompatibility,
  compareVersions,
  isAppCapability,
  isAppId,
  isPackagePath,
  isReservedNamespace,
  satisfies,
} from "./index.ts";
import { elevatedCapabilities, ManifestError, parseManifest } from "./schema.ts";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: "dev.everyos.notes",
    name: "Notes",
    version: "1.0.0",
    description: "Personal notes for EveryOS",
    entry: "index.html",
    icon: "assets/icon.png",
    category: "productivity",
    permissions: ["storage:app", "files:pick", "files:save", "widgets:register"],
    window: {
      defaultWidth: 900,
      defaultHeight: 650,
      minWidth: 420,
      minHeight: 320,
      instances: "multiple",
    },
    widgets: [
      {
        id: "quick-note",
        name: "Quick note",
        description: "Write a note from the desktop",
        entry: "widgets/quick-note/index.html",
        sizes: ["small", "medium"],
        defaultSize: "small",
        placements: ["desktop", "sidebar"],
        permissions: ["storage:app"],
      },
    ],
    locales: { default: "en", supported: ["en", "tr"], path: "locales" },
    minEveryOS: "0.2.0",
    sdk: "^1.0.0",
    publisher: { id: "dev.everyos", name: "EveryOS" },
    license: "MIT",
    ...overrides,
  };
}

const issues = (value: unknown) => {
  try {
    parseManifest(value);
    return [];
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    return error.issues.map((issue) => issue.message);
  }
};

describe("app manifest", () => {
  it("accepts a complete manifest", () => {
    expect(parseManifest(manifest()).widgets[0]?.id).toBe("quick-note");
  });

  it("rejects unknown keys, bad identities and paths that leave the package", () => {
    expect(issues(manifest({ official: true }))).not.toEqual([]);
    expect(issues(manifest({ id: "io.github.alice.notes" }))).toContain(
      "app-outside-publisher-namespace",
    );
    expect(issues(manifest({ id: "Notes" }))).toContain("invalid-app-id");
    for (const entry of ["../index.html", "/index.html", "a\\b.html", "./index.html", "app.js"])
      expect(issues(manifest({ entry })), entry).toContain("invalid-path");
    expect(issues(manifest({ icon: "assets/icon.gif" }))).toContain("invalid-path");
    expect(issues(manifest({ homepage: "http://example.com" }))).toContain("invalid-url");
    expect(issues(manifest({ name: "Notes\u0007" }))).toContain("invalid-text");
  });

  it("keeps permissions, widgets and locales consistent", () => {
    expect(issues(manifest({ permissions: ["storage:app", "storage:app"] }))).toEqual(
      expect.arrayContaining(["duplicate-permission"]),
    );
    expect(issues(manifest({ permissions: ["shell:exec"] }))).toContain("unknown-capability");
    expect(issues(manifest({ permissions: ["files:pick"] }))).toEqual(
      expect.arrayContaining(["widgets-need-widgets-register", "widget-permission-not-in-app"]),
    );
    expect(
      issues(manifest({ locales: { default: "de", supported: ["en"], path: "locales" } })),
    ).toContain("default-locale-not-supported");
    expect(
      issues(
        manifest({
          window: {
            defaultWidth: 300,
            defaultHeight: 300,
            minWidth: 400,
            minHeight: 300,
            instances: "single",
          },
        }),
      ),
    ).toContain("min-exceeds-default");
    expect(
      issues(manifest({ permissions: ["integration:uptimekuma", "storage:app"], widgets: [] })),
    ).toContain("integration-capability-without-integration");
    expect(
      parseManifest(
        manifest({
          permissions: ["integration:uptimekuma"],
          widgets: [],
          integration: { adapter: "uptimekuma" },
        }),
      ).integration?.adapter,
    ).toBe("uptimekuma");
  });

  it("names elevated capabilities that need an administrator", () => {
    expect(
      elevatedCapabilities({
        permissions: ["storage:app", "network:outbound", "database:connect"],
      }),
    ).toEqual(["network:outbound", "database:connect"]);
  });
});

describe("identities", () => {
  it("separates publisher namespaces at dot boundaries and reserves EveryOS names", () => {
    expect(isAppId("io.github.alice.todo")).toBe(true);
    expect(isAppId("alice.todo")).toBe(false);
    expect(appBelongsTo("io.github.alice.todo", "io.github.alice")).toBe(true);
    expect(appBelongsTo("io.github.alicex.todo", "io.github.alice")).toBe(false);
    expect(isReservedNamespace("dev.everyos.notes")).toBe(true);
    expect(isReservedNamespace("everyos.fake.notes")).toBe(true);
    expect(isReservedNamespace("dev.everyosx.notes")).toBe(false);
  });

  it("accepts only package-safe paths", () => {
    expect(isPackagePath("assets/index-Bx3f_.js")).toBe(true);
    for (const path of ["", "a//b", "a/../b", "..", "a/./b", "/a", "a b", "a\\b", "é.js"])
      expect(isPackagePath(path), path).toBe(false);
  });
});

describe("versions", () => {
  it("orders releases after their pre-releases", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("matches caret, tilde, minimum, exact and any ranges", () => {
    expect(satisfies("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("1.1.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.3.5", "^0.3.1")).toBe(true);
    expect(satisfies("0.4.0", "^0.3.1")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("9.0.0", ">=1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.0.0-rc.1", "*")).toBe(false);
    expect(satisfies("1.0.0-rc.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0-rc.2", "^1.0.0-rc.1")).toBe(true);
    expect(() => satisfies("1.0.0", "1.x")).toThrow();
  });

  it("checks whether this EveryOS can run an app", () => {
    const host = { everyosVersion: "0.2.0", sdkVersion: "1.1.0" };
    expect(checkCompatibility({ sdk: "^1.0.0", minEveryOS: "0.2.0" }, host)).toEqual({ ok: true });
    expect(checkCompatibility({ sdk: "^1.0.0", minEveryOS: "0.3.0" }, host)).toEqual({
      ok: false,
      reason: "everyos-too-old",
    });
    expect(checkCompatibility({ sdk: "^1.2.0" }, host)).toEqual({
      ok: false,
      reason: "sdk-unsupported",
    });
  });
});

describe("contracts with EveryOS", () => {
  it("offers exactly the interface languages", () => {
    expect([...APP_LOCALES].sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("asks only for existing role permissions and recognises integrations", () => {
    for (const capability of APP_CAPABILITIES)
      for (const permission of CAPABILITY_INFO[capability].requires)
        expect(PERMISSIONS as readonly string[], `${capability}`).toContain(permission);
    expect(isAppCapability("integration:homeassistant")).toBe(true);
    expect(isAppCapability("integration:")).toBe(false);
    expect(capabilityInfo("integration:homeassistant")).toEqual({
      risk: "sensitive",
      requires: ["apps:read"],
    });
  });
});
