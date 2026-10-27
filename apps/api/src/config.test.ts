import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "./config.ts";
import { OFFICIAL_APP_REGISTRY } from "./modules/desktop-apps/anchors.ts";

describe("development official app registry configuration", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "everyos-dev-registry-config-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const anchor = {
    url: "http://127.0.0.1:12345/official-apps.json",
    publicKey: OFFICIAL_APP_REGISTRY.publicKey,
    allowPrivate: true,
  };

  it("loads the locally generated anchor only in development", () => {
    writeFileSync(join(root, "official-app-registry.json"), JSON.stringify(anchor));
    const config = loadApiConfig({ EVERYOS_ENV: "development", EVERYOS_DEV_ROOT: root });
    expect(config.desktopApps.officialRegistry).toEqual(anchor);
  });

  it("retains the published anchor when no development registry is running", () => {
    const config = loadApiConfig({ EVERYOS_ENV: "development", EVERYOS_DEV_ROOT: root });
    expect(config.desktopApps.officialRegistry).toEqual(OFFICIAL_APP_REGISTRY);
  });

  it("ignores development files in production, even when a dev root is set", () => {
    writeFileSync(join(root, "official-app-registry.json"), "invalid development data");
    const file = join(root, "config.yaml");
    writeFileSync(file, "{}");
    const config = loadApiConfig({
      EVERYOS_ENV: "production",
      EVERYOS_CONFIG: file,
      EVERYOS_DEV_ROOT: root,
    });
    expect(config.desktopApps.officialRegistry).toEqual(OFFICIAL_APP_REGISTRY);
    expect(config.desktopApps.officialRegistry?.allowPrivate).toBeUndefined();
  });

  it("gives the explicit operator configuration priority over generated development data", () => {
    writeFileSync(join(root, "official-app-registry.json"), "invalid development data");
    const file = join(root, "config.yaml");
    writeFileSync(
      file,
      JSON.stringify({ desktopApps: { officialRegistry: OFFICIAL_APP_REGISTRY } }),
    );
    const config = loadApiConfig({
      EVERYOS_ENV: "development",
      EVERYOS_CONFIG: file,
      EVERYOS_DEV_ROOT: root,
    });
    expect(config.desktopApps.officialRegistry).toEqual(OFFICIAL_APP_REGISTRY);
  });

  it.each(["not JSON", JSON.stringify({ ...anchor, unexpected: true })])(
    "rejects malformed generated anchors without falling back to another trust source",
    (data) => {
      writeFileSync(join(root, "official-app-registry.json"), data);
      expect(() => loadApiConfig({ EVERYOS_ENV: "development", EVERYOS_DEV_ROOT: root })).toThrow(
        "Invalid development app registry configuration",
      );
    },
  );
});
