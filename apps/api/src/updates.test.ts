import type { AptUpdates, NotificationList, PackageInfo, UpdateJobView } from "@otuken/shared";
import { describe, expect, it, vi } from "vitest";
import { UpdateService } from "./modules/updates/update-service.ts";
import { json, readEvents, withRoles, type TestContext } from "./test-support.ts";

async function finished(ctx: TestContext, id: string): Promise<UpdateJobView> {
  await vi.waitFor(() => expect(ctx.services.updates.job(id)?.status).not.toBe("running"));
  return ctx.services.updates.job(id)!;
}

describe("update manager", () => {
  it("lists updates and package details for readers, changes only for system managers", async () => {
    const { admin, operator, viewer } = await withRoles();
    const list = await json<{ updates: AptUpdates; running: null }>(
      await viewer.get("/api/updates"),
    );
    expect(list.updates).toMatchObject({ source: "simulated", total: 5, security: 2 });
    expect(list.updates.packages.find((p) => p.name === "openssl")).toMatchObject({
      name: "openssl",
      currentVersion: "3.0.13-0ubuntu3.5",
    });
    const info = await json<PackageInfo>(await viewer.get("/api/updates/packages/openssl"));
    expect(info).toMatchObject({ candidateVersion: "3.0.13-0ubuntu3.6", security: true });
    expect((await viewer.get("/api/updates/packages/..%2Fetc")).status).toBe(400);

    expect((await viewer.post("/api/updates/refresh", {})).status).toBe(403);
    expect((await operator.post("/api/updates/upgrade", { all: true, confirm: true })).status).toBe(
      403,
    );
    // Upgrades need explicit confirmation.
    expect((await admin.post("/api/updates/upgrade", { all: true })).status).toBe(400);
  });

  it("refreshes lists and upgrades selected packages in the background with history, audit and notifications", async () => {
    const { ctx, admin, viewer } = await withRoles();
    const refresh = await json<UpdateJobView>(await admin.post("/api/updates/refresh", {}));
    expect(refresh).toMatchObject({ action: "refresh", status: "running", username: "admin" });
    expect((await finished(ctx, refresh.id)).status).toBe("succeeded");

    const response = await admin.post("/api/updates/upgrade", {
      packages: ["curl", "tzdata"],
      confirm: true,
    });
    expect(response.status).toBe(202);
    const job = await json<UpdateJobView>(response);
    // One job at a time.
    expect((await admin.post("/api/updates/refresh", {})).status).toBe(409);
    const stream = await viewer.get(`/api/updates/jobs/${job.id}/events`);
    const { events } = await readEvents(stream, 6, 5_000);
    expect(events.filter((e) => e.event === "line").length).toBeGreaterThan(0);
    const done = await finished(ctx, job.id);
    expect(done).toMatchObject({ status: "succeeded", upgraded: 2, packages: ["curl", "tzdata"] });
    expect(done.output).toContain("Setting up curl");

    const remaining = await json<{ updates: AptUpdates }>(await viewer.get("/api/updates"));
    expect(remaining.updates.packages.map((p) => p.name)).toEqual([
      "libssl3t64",
      "openssl",
      "docker-ce",
    ]);
    const history = await json<{ jobs: UpdateJobView[] }>(await viewer.get("/api/updates/jobs"));
    expect(history.jobs.map((j) => j.action)).toEqual(["upgrade", "refresh"]);

    const notes = await json<NotificationList>(
      await viewer.get("/api/notifications?category=updates"),
    );
    expect(notes.notifications.find((n) => n.kind === "updates-installed")?.params).toEqual({
      count: 2,
    });
    const audit = ctx.db.all<{ action: string; outcome: string; target: string }>(
      "SELECT action, outcome, target FROM audit_events WHERE action LIKE 'updates.%' ORDER BY id",
    );
    expect(audit).toEqual([
      { action: "updates.refresh", outcome: "success", target: "lists" },
      { action: "updates.upgrade", outcome: "success", target: "curl tzdata" },
    ]);
  });

  it("reports failed upgrades and marks jobs interrupted by a restart", async () => {
    const { ctx, admin, viewer } = await withRoles();
    ctx.agent.streamHandlers.set("apt.upgrade", async function* () {
      yield await Promise.resolve({
        type: "line",
        text: "E: Could not get lock /var/lib/dpkg/lock-frontend",
      });
      yield { type: "done", ok: false, exitCode: 100, upgraded: null, busy: true };
    });
    const job = await json<UpdateJobView>(
      await admin.post("/api/updates/upgrade", { all: true, confirm: true }),
    );
    expect(await finished(ctx, job.id)).toMatchObject({
      status: "failed",
      error: "busy",
      packages: null,
    });
    const notes = await json<NotificationList>(
      await viewer.get("/api/notifications?category=updates"),
    );
    expect(notes.notifications[0]).toMatchObject({
      kind: "updates-failed",
      params: { reason: "busy" },
    });

    ctx.db.run("UPDATE update_jobs SET status = 'running' WHERE id = ?", job.id);
    new UpdateService({
      db: ctx.db,
      agent: ctx.agent,
      audit: ctx.services.audit,
      notifications: ctx.services.notifications,
      logger: ctx.services.logger,
      now: () => ctx.clock.now,
    });
    expect(ctx.services.updates.job(job.id)?.status).toBe("interrupted");
  });
});
