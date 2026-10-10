import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AppJobView, CatalogView, InstalledAppView } from "@otuken/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { AppService } from "./modules/apps/app-service.ts";
import { CatalogService } from "./modules/catalogs/catalog-service.ts";
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
const source =
  "services:\n  app:\n    image: example.invalid/test:1\n    environment:\n      PASSWORD: ${TEST_PASSWORD}\n    ports: ['8123:80']\n";
async function fixture(compose = source) {
  const roles = await withRoles();
  const { ctx, admin } = roles;
  contexts.push(ctx);
  const catalogs = new CatalogService(
    ctx.db,
    () => ctx.clock.now,
    () => ({ get: () => Promise.resolve(Buffer.from(compose)) }),
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
  const catalog = await json<CatalogView>(
    await admin.post("/api/catalogs", {
      name: "Original test catalog",
      url: "https://fixture.invalid/test.yml",
    }),
  );
  await catalogs.sync(catalog.id);
  const app = catalogs.apps()[0]!;
  return {
    ...roles,
    catalog,
    app,
    input: {
      appId: app.id,
      snapshot: app.source.ref,
      variables: { TEST_PASSWORD: "private-install-secret-$value" },
      ports: [{ service: "app", index: 0, host: 8123 }],
      acknowledgeRisks: true,
    },
  };
}
async function finished(ctx: TestContext, id: string) {
  await vi.waitFor(() => expect(ctx.services.apps.job(id)?.stage).toMatch(/succeeded|failed/));
  return ctx.services.apps.job(id)!;
}
describe("App Store installations", () => {
  it("reconciles only the exact interrupted job and refuses concurrent agent mutations", async () => {
    const { ctx, admin, viewer, input } = await fixture();
    ctx.agent.handlers.set("apps.run", () => ({
      source: "simulated",
      ok: true,
      rollback: "not-needed",
    }));
    const job = await json<AppJobView>(await admin.post("/api/apps/install", input));
    await finished(ctx, job.id);
    ctx.db.run(
      "UPDATE app_jobs SET stage = 'failed', error = 'interrupted', rollback = 'unknown' WHERE id = ?",
      job.id,
    );
    ctx.db.run("UPDATE installed_apps SET last_error = 'interrupted' WHERE id = ?", job.appId);
    const lastRun = {
      jobId: String(randomUUID()),
      action: "install",
      ok: true,
      rollback: "not-needed",
      images: [],
    };
    ctx.agent.handlers.set("apps.inspect", () => ({
      source: "simulated",
      ownership: "deployed",
      busy: false,
      lastRun,
    }));
    expect((await viewer.post(`/api/apps/${job.appId}/reconcile`, {})).status).toBe(403);
    expect((await admin.post(`/api/apps/${job.appId}/reconcile`, {})).status).toBe(200);
    expect(ctx.services.apps.job(job.id)?.error).toBe("interrupted");
    lastRun.jobId = job.id;
    await admin.post(`/api/apps/${job.appId}/reconcile`, {});
    expect(ctx.services.apps.job(job.id)).toMatchObject({
      stage: "succeeded",
      error: null,
      rollback: "not-needed",
    });
    const listed = await json<{ apps: InstalledAppView[] }>(await admin.get("/api/apps"));
    expect(listed.apps[0]?.lastJob?.id).toBe(job.id);
    expect(listed.apps[0]?.lastError).toBeNull();
    ctx.agent.handlers.set("apps.inspect", () => ({
      source: "simulated",
      ownership: "deployed",
      busy: true,
      lastRun,
    }));
    expect(
      (
        await admin.post(`/api/apps/${job.appId}/actions`, {
          action: "retry",
          confirmId: job.appId,
        })
      ).status,
    ).toBe(409);
  });
  it("validates permission and snapshot, encrypts configuration and never exposes passwords", async () => {
    const { ctx, admin, viewer, operator, input } = await fixture();
    ctx.agent.handlers.set("apps.run", () => ({
      source: "simulated",
      ok: true,
      rollback: "not-needed",
    }));
    expect((await viewer.post("/api/apps/install", input)).status).toBe(403);
    expect(
      (await admin.post("/api/apps/install", { ...input, snapshot: "0".repeat(64) })).status,
    ).toBe(409);
    expect(
      (await admin.post("/api/apps/install", { ...input, variables: { UNKNOWN: "secret" } }))
        .status,
    ).toBe(422);
    const response = await operator.post("/api/apps/install", input);
    expect(response.status).toBe(202);
    const job = await json<AppJobView>(response);
    expect((await finished(ctx, job.id)).stage).toBe("succeeded");
    const row = ctx.db.get<{ sealed_compose: string }>(
      "SELECT sealed_compose FROM installed_apps WHERE id = ?",
      job.appId,
    )!;
    expect(row.sealed_compose).toMatch(/^v1\./);
    expect(row.sealed_compose).not.toContain("private-install-secret");
    expect(ctx.services.secrets.open(row.sealed_compose, `app:${job.appId}:compose:v1`)).toContain(
      "private-install-secret-$$value",
    );
    const apps = await json<{ apps: InstalledAppView[] }>(await viewer.get("/api/apps"));
    expect(apps.apps[0]?.state).toBe("missing"); // No pretend container state from a successful job.
    expect(JSON.stringify(apps)).not.toContain("private-install-secret");
    const details = ctx.db.all<{ details: string }>(
      "SELECT details FROM audit_events WHERE action LIKE 'apps.%'",
    );
    expect(JSON.stringify(details)).not.toContain("private-install-secret");
  });
  it("requires admin approval for host access and explicit lifecycle confirmation", async () => {
    const { ctx, admin, operator, input } = await fixture(`${source}    privileged: true\n`);
    ctx.agent.handlers.set("apps.run", () => ({
      source: "simulated",
      ok: true,
      rollback: "not-needed",
    }));
    expect((await operator.post("/api/apps/install", input)).status).toBe(403);
    expect(
      (await admin.post("/api/apps/install", { ...input, acknowledgeRisks: false })).status,
    ).toBe(422);
    const job = await json<AppJobView>(await admin.post("/api/apps/install", input));
    await finished(ctx, job.id);
    expect((await admin.post(`/api/apps/${job.appId}/actions`, { action: "remove" })).status).toBe(
      422,
    );
    expect(
      (
        await operator.post(`/api/apps/${job.appId}/actions`, {
          action: "update",
          confirmId: job.appId,
        })
      ).status,
    ).toBe(403);
    const removal = await json<AppJobView>(
      await admin.post(`/api/apps/${job.appId}/actions`, {
        action: "remove",
        confirmId: job.appId,
      }),
    );
    await finished(ctx, removal.id);
    expect((await ctx.services.apps.list(ctx.agent.calls[0]!.actor)).length).toBe(0);
  });
  it("retains installation provenance when a catalog is removed and reports rollback failure", async () => {
    const { ctx, admin, input, catalog } = await fixture();
    ctx.agent.handlers.set("apps.run", () => ({
      source: "simulated",
      ok: false,
      rollback: "failed",
    }));
    const job = await json<AppJobView>(await admin.post("/api/apps/install", input));
    expect(await finished(ctx, job.id)).toMatchObject({ stage: "failed", rollback: "failed" });
    expect((await admin.delete(`/api/catalogs/${catalog.id}`, { body: {} })).status).toBe(204);
    const apps = await json<{ apps: InstalledAppView[] }>(await admin.get("/api/apps"));
    expect(apps.apps[0]?.provenance.catalogId).toBe(catalog.id);
    const project = apps.apps[0]!.project;
    expect(ctx.services.apps.owns(project)).toBe(true);
    expect((await admin.post(`/api/docker/projects/${project}/import`, {})).status).toBe(409);
    expect((await admin.get(`/api/apps/jobs/${randomUUID()}?extra=true`)).status).toBe(400);
  });
});
