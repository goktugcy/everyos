import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogAppView, CatalogView } from "@otuken/shared";
import { createApp } from "./app.ts";
import { CatalogService } from "./modules/catalogs/catalog-service.ts";
import { json, withRoles, type TestContext } from "./test-support.ts";

const contexts: TestContext[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    ctx.services.metrics.stop();
    ctx.services.docker.stop();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
const source =
  "services:\n  app:\n    image: example.invalid/test:1\n    environment:\n      PASSWORD: ${TEST_PASSWORD:-do-not-disclose}\n";

describe("catalog API", () => {
  it("proxies and caches raster screenshots while rejecting active content and strict invalid paths", async () => {
    const { ctx, admin, viewer } = await withRoles();
    contexts.push(ctx);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    let imageUrl = "https://assets.invalid/screen.png",
      imageCalls = 0;
    ctx.services.catalogs = new CatalogService(
      ctx.db,
      () => ctx.clock.now,
      () => ({
        get: (url) => {
          if (url.includes("assets.invalid")) {
            imageCalls++;
            return Promise.resolve(
              url.endsWith("svg") ? Buffer.from("<svg onload='alert(1)' />") : png,
            );
          }
          return Promise.resolve(
            Buffer.from(source + `x-casaos:\n  screenshot_link: ['${imageUrl}']\n`),
          );
        },
      }),
    );
    ctx.app = createApp(ctx.services);
    const catalog = await json<CatalogView>(
      await admin.post("/api/catalogs", { name: "Images", url: "https://fixture.invalid/a" }),
    );
    await admin.post(`/api/catalogs/${catalog.id}/sync`, {});
    const app = ctx.services.catalogs.apps()[0]!;
    const url = app.screenshots[0]!;
    expect(url).toMatch(/^\/api\/catalogs\/apps\//);
    expect((await viewer.get(url)).headers.get("content-type")).toBe("image/png");
    expect((await viewer.get(url)).status).toBe(200);
    expect(imageCalls).toBe(1);
    expect((await viewer.get(url.replace(/\/0$/, "/12"))).status).toBe(400);
    imageUrl = "https://assets.invalid/screen.svg";
    await admin.post(`/api/catalogs/${catalog.id}/sync`, {});
    expect((await viewer.get(url)).status).toBe(404);
  });
  it("enforces roles, validates strict input, preserves snapshots on failure and masks secret defaults", async () => {
    const { ctx, admin, viewer, operator } = await withRoles();
    contexts.push(ctx);
    let fail = false;
    ctx.services.catalogs = new CatalogService(
      ctx.db,
      () => ctx.clock.now,
      () => ({
        get: () =>
          fail
            ? Promise.reject(new Error("sensitive upstream error"))
            : Promise.resolve(Buffer.from(source)),
      }),
    );
    ctx.app = createApp(ctx.services);
    const owner = admin;
    expect((await viewer.get("/api/catalogs")).status).toBe(403);
    expect(
      (await operator.post("/api/catalogs", { name: "Test", url: "https://fixture.invalid" }))
        .status,
    ).toBe(403);
    expect(
      (await owner.post("/api/catalogs", { name: "Test", url: "file:///etc/passwd" })).status,
    ).toBe(400);
    expect(
      (
        await owner.post("/api/catalogs", {
          name: "Test",
          url: "https://fixture.invalid",
          surprise: true,
        })
      ).status,
    ).toBe(400);
    const catalog = await json<CatalogView>(
      await owner.post("/api/catalogs", {
        name: "Test",
        url: "https://fixture.invalid",
        allowPrivate: false,
      }),
    );
    const synced = await json<CatalogView>(
      await owner.post(`/api/catalogs/${catalog.id}/sync`, {}),
    );
    expect(synced.appCount).toBe(1);
    const apps = await json<{ apps: CatalogAppView[] }>(await viewer.get("/api/catalogs/apps"));
    expect(apps.apps[0]?.variables[0]?.default).toBeNull();
    expect(JSON.stringify(apps)).not.toContain("do-not-disclose");
    expect(JSON.stringify(apps)).not.toContain("compose:");
    fail = true;
    expect((await owner.post(`/api/catalogs/${catalog.id}/sync`, {})).status).toBe(400);
    expect(ctx.services.catalogs.get(catalog.id)?.snapshot).toBe(synced.snapshot);
    expect(ctx.services.catalogs.apps()).toHaveLength(1);
    expect(ctx.services.catalogs.get(catalog.id)?.lastError).toBe("sync-failed");
    expect((await owner.patch(`/api/catalogs/${catalog.id}`, { enabled: false })).status).toBe(200);
    expect(ctx.services.catalogs.apps()).toHaveLength(0);
    expect(ctx.services.catalogs.get(catalog.id)?.appCount).toBe(1);
    const events = ctx.db.all<{ action: string; details: string | null }>(
      "SELECT action, details FROM audit_events WHERE action LIKE 'catalogs.%'",
    );
    expect(events.some((entry) => entry.action === "catalogs.sync")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("sensitive upstream error");
  });
  it("detects duplicate logical apps across catalogs and keeps catalog metadata admin-only", async () => {
    const { ctx, admin, viewer } = await withRoles();
    contexts.push(ctx);
    ctx.services.catalogs = new CatalogService(
      ctx.db,
      () => ctx.clock.now,
      () => ({ get: () => Promise.resolve(Buffer.from(source)) }),
    );
    ctx.app = createApp(ctx.services);
    for (const name of ["First", "Second"]) {
      const catalog = await json<CatalogView>(
        await admin.post("/api/catalogs", { name, url: `https://fixture.invalid/${name}` }),
      );
      expect((await admin.post(`/api/catalogs/${catalog.id}/sync`, {})).status).toBe(200);
    }
    const apps = await json<{ apps: CatalogAppView[] }>(await viewer.get("/api/catalogs/apps"));
    expect(apps.apps).toHaveLength(2);
    expect(apps.apps[0]?.duplicates).toEqual([apps.apps[1]?.id]);
    expect((await viewer.get("/api/catalogs/apps?extra=true")).status).toBe(400);
  });
});
