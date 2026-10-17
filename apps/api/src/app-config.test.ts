import { rmSync } from "node:fs";
import type {
  AppConfiguration,
  AppJobView,
  CatalogView,
  InstalledAppView,
  NotificationList,
} from "@everyos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { AppService } from "./modules/apps/app-service.ts";
import { CatalogService } from "./modules/catalogs/catalog-service.ts";
import { HostMonitor } from "./modules/notifications/host-monitor.ts";
import { json, withRoles, type TestContext } from "./test-support.ts";

const contexts: TestContext[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    ctx.services.metrics.stop();
    ctx.services.docker.stop();
    ctx.services.apps.stop();
    ctx.services.catalogs.stop();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const definition = (tag: string, extra = "") => `services:
  app:
    image: example.invalid/app:${tag}
    environment:
      PASSWORD: \${TEST_PASSWORD}
      MODE: \${MODE:-fast}${extra}
    ports: ['8123:80']
`;

async function fixture() {
  const roles = await withRoles();
  const { ctx, admin } = roles;
  contexts.push(ctx);
  const catalogSource = { compose: definition("1") };
  const catalogs = new CatalogService(
    ctx.db,
    () => ctx.clock.now,
    () => ({ get: () => Promise.resolve(Buffer.from(catalogSource.compose)) }),
  );
  ctx.services.catalogs = catalogs;
  ctx.services.apps = new AppService({
    db: ctx.db,
    catalogs,
    agent: ctx.agent,
    secrets: ctx.services.secrets,
    audit: ctx.services.audit,
    now: () => ctx.clock.now,
  });
  ctx.app = createApp(ctx.services);
  ctx.agent.handlers.set("apps.run", () => ({
    source: "simulated",
    ok: true,
    rollback: "not-needed",
  }));
  const catalog = await json<CatalogView>(
    await admin.post("/api/catalogs", {
      name: "Settings catalog",
      url: "https://fixture.invalid/a.yml",
    }),
  );
  await catalogs.sync(catalog.id);
  const entry = catalogs.apps()[0]!;
  const installed = await json<AppJobView>(
    await admin.post("/api/apps/install", {
      appId: entry.id,
      snapshot: entry.source.ref,
      variables: { TEST_PASSWORD: "install-secret-value", MODE: "fast" },
      ports: [{ service: "app", index: 0, host: 8123 }],
      acknowledgeRisks: true,
    }),
  );
  await finished(ctx, installed.id);
  const monitor = new HostMonitor({
    agent: ctx.agent,
    notifications: ctx.services.notifications,
    logger: ctx.services.logger,
    appUpdates: () => ctx.services.apps.catalogUpdates(),
  });
  return { ...roles, catalogs, catalog, catalogSource, appId: installed.appId, monitor };
}
async function finished(ctx: TestContext, id: string) {
  await vi.waitFor(() => expect(ctx.services.apps.job(id)?.stage).toMatch(/succeeded|failed/));
  return ctx.services.apps.job(id)!;
}
const lastCompose = (ctx: TestContext) =>
  (ctx.agent.calls.filter((call) => call.op === "apps.run").at(-1)!.params as { compose: string })
    .compose;

describe("installed app settings and catalog updates", () => {
  it("changes settings while keeping secrets, then moves to the catalog's newer definition", async () => {
    const { ctx, admin, viewer, catalogs, catalog, catalogSource, appId, monitor } =
      await fixture();
    const view = async () =>
      (await json<{ apps: InstalledAppView[] }>(await admin.get("/api/apps"))).apps[0]!;
    expect(await view()).toMatchObject({ configurable: true, catalogUpdate: null });
    expect((await viewer.get(`/api/apps/${appId}/configuration`)).status).toBe(403);
    const form = await admin.get(`/api/apps/${appId}/configuration`);
    const text = await form.clone().text();
    expect(text).not.toContain("install-secret-value");
    const current = await json<AppConfiguration>(form);
    expect(current.variables.find((v) => v.key === "TEST_PASSWORD")).toMatchObject({
      value: null,
      hasValue: true,
    });
    expect(current.variables.find((v) => v.key === "MODE")).toMatchObject({ value: "fast" });
    expect(current.fixedPorts).toEqual([{ service: "app", index: 0, host: 8123 }]);

    const change = (body: Record<string, unknown>) =>
      admin.post(`/api/apps/${appId}/configure`, {
        target: "current",
        variables: {},
        ports: [{ service: "app", index: 0, host: 8123 }],
        acknowledgeRisks: true,
        confirmId: appId,
        ...body,
      });
    expect((await change({ confirmId: "00000000-0000-4000-8000-000000000000" })).status).toBe(422);
    expect((await change({ variables: { UNKNOWN: "x" } })).status).toBe(422);
    const changed = await change({ variables: { MODE: "safe", TEST_PASSWORD: "" } });
    expect(changed.status).toBe(202);
    await finished(ctx, (await json<AppJobView>(changed)).id);
    const applied = lastCompose(ctx);
    expect(applied).toContain("MODE: safe");
    expect(applied).toContain("PASSWORD: install-secret-value");
    expect(
      (
        ctx.agent.calls.filter((call) => call.op === "apps.run").at(-1)!.params as {
          previousComposeHash?: string;
        }
      ).previousComposeHash,
    ).toMatch(/^[a-f0-9]{64}$/);
    const unchanged = await change({ variables: { MODE: "safe" } });
    expect(unchanged.status).toBe(409);
    expect(await unchanged.text()).toContain("unchanged");

    // The catalog moves the app to a new image and adds a setting.
    catalogSource.compose = definition("2", "\n      LEVEL: ${LEVEL:-3}");
    await catalogs.sync(catalog.id);
    expect((await view()).catalogUpdate).not.toBeNull();
    await monitor.check();
    const notices = await json<NotificationList>(await viewer.get("/api/notifications"));
    expect(notices.notifications.find((n) => n.kind === "app-update-available")).toMatchObject({
      resolvedAt: null,
      params: { appId },
    });
    const next = await json<AppConfiguration>(
      await admin.get(`/api/apps/${appId}/configuration?target=update`),
    );
    expect(next.images).toContain("example.invalid/app:2");
    expect(next.variables.find((v) => v.key === "MODE")).toMatchObject({ value: "safe" });
    const updated = await change({ target: "update" });
    expect(updated.status).toBe(202);
    await finished(ctx, (await json<AppJobView>(updated)).id);
    const upgraded = lastCompose(ctx);
    expect(upgraded).toContain("example.invalid/app:2");
    expect(upgraded).toContain("PASSWORD: install-secret-value");
    expect(upgraded).toContain("MODE: safe");
    expect(upgraded).toContain('LEVEL: "3"');
    expect(await view()).toMatchObject({ configurable: true, catalogUpdate: null });
    await monitor.check();
    expect(
      (await json<NotificationList>(await viewer.get("/api/notifications"))).notifications.find(
        (n) => n.kind === "app-update-available",
      )?.resolvedAt,
    ).not.toBeNull();
  });

  it("adopts earlier installations only when their stored file is reproduced exactly", async () => {
    const { ctx, admin, appId } = await fixture();
    const forget = (extra: (metadata: Record<string, unknown>) => void = () => undefined) => {
      const row = ctx.db.get<{ metadata: string }>(
        "SELECT metadata FROM installed_apps WHERE id = ?",
        appId,
      )!;
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      delete metadata.inputs;
      delete metadata.template;
      delete metadata.catalog;
      delete metadata.inputsUnavailable;
      extra(metadata);
      ctx.db.run(
        "UPDATE installed_apps SET metadata = ? WHERE id = ?",
        JSON.stringify(metadata),
        appId,
      );
    };
    forget();
    const adopted = (await json<{ apps: InstalledAppView[] }>(await admin.get("/api/apps")))
      .apps[0]!;
    expect(adopted).toMatchObject({ configurable: true, catalogUpdate: null });
    // The recovered secret is kept by a settings change.
    const changed = await admin.post(`/api/apps/${appId}/configure`, {
      target: "current",
      variables: { MODE: "other" },
      ports: [{ service: "app", index: 0, host: 8123 }],
      acknowledgeRisks: true,
      confirmId: appId,
    });
    expect(changed.status).toBe(202);
    await finished(ctx, (await json<AppJobView>(changed)).id);
    expect(lastCompose(ctx)).toContain("PASSWORD: install-secret-value");

    // A stored file the catalog definition cannot reproduce stays as it is.
    forget();
    const sealed = ctx.db.get<{ sealed_compose: string }>(
      "SELECT sealed_compose FROM installed_apps WHERE id = ?",
      appId,
    )!.sealed_compose;
    const edited = ctx.services.secrets
      .open(sealed, `app:${appId}:compose:v1`)
      .replace("example.invalid/app:1", "example.invalid/app:custom");
    ctx.db.run(
      "UPDATE installed_apps SET sealed_compose = ? WHERE id = ?",
      ctx.services.secrets.seal(edited, `app:${appId}:compose:v1`),
      appId,
    );
    expect(
      (await json<{ apps: InstalledAppView[] }>(await admin.get("/api/apps"))).apps[0]!
        .configurable,
    ).toBe(false);
    const refused = await admin.get(`/api/apps/${appId}/configuration`);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("inputs-unavailable");
  });
});
