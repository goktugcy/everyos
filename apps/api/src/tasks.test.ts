import type { NotificationList, TaskRunView, TaskView } from "@otuken/shared";
import { describe, expect, it, vi } from "vitest";
import { taskExecutors } from "./modules/tasks/executors.ts";
import { TaskService } from "./modules/tasks/task-service.ts";
import { json, withRoles, type TestContext } from "./test-support.ts";

const minute = 60_000;

async function lastRun(ctx: TestContext, taskId: string): Promise<TaskRunView> {
  await vi.waitFor(() => expect(ctx.services.tasks.runs(taskId)[0]?.status).not.toBe("running"));
  return ctx.services.tasks.runs(taskId)[0]!;
}

describe("scheduled tasks", () => {
  it("only allows predefined actions the creator may perform, on sane schedules", async () => {
    const { admin, operator, viewer } = await withRoles();
    const restart = {
      name: "Gece yeniden başlat",
      type: "service.restart",
      params: { unit: "jellyfin.service" },
      schedule: "30 3 * * *",
    };
    expect((await viewer.post("/api/tasks", restart)).status).toBe(403);
    // Operators manage tasks and services, but not package updates.
    expect((await operator.post("/api/tasks", restart)).status).toBe(201);
    expect(
      (await operator.post("/api/tasks", { ...restart, type: "updates.refresh", params: {} }))
        .status,
    ).toBe(403);
    // No arbitrary commands, no unknown parameters, no invalid or too frequent schedules.
    expect(
      (await admin.post("/api/tasks", { ...restart, type: "shell.run", params: { command: "id" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/tasks", {
          ...restart,
          params: { unit: "jellyfin.service", extra: "x" },
        })
      ).status,
    ).toBe(400);
    expect((await admin.post("/api/tasks", { ...restart, schedule: "61 * * * *" })).status).toBe(
      400,
    );
    expect((await admin.post("/api/tasks", { ...restart, schedule: "* * * * *" })).status).toBe(
      400,
    );
    const list = await json<{ tasks: TaskView[]; types: string[] }>(
      await operator.get("/api/tasks"),
    );
    expect(list.types).toEqual([
      "service.restart",
      "container.restart",
      "app.update",
      "backup.create",
    ]);
    expect(list.tasks[0]).toMatchObject({
      name: "Gece yeniden başlat",
      owner: "operator",
      enabled: true,
    });
  });

  it("runs due tasks as their owner, records history and reschedules", async () => {
    const { ctx, admin } = await withRoles();
    // A daily schedule two hours from now (relative to the test clock and time zone).
    const target = new Date(ctx.clock.now + 2 * 60 * minute);
    target.setSeconds(0, 0);
    const task = await json<TaskView>(
      await admin.post("/api/tasks", {
        name: "Jellyfin",
        type: "service.restart",
        params: { unit: "jellyfin.service" },
        schedule: `${target.getMinutes()} ${target.getHours()} * * *`,
      }),
    );
    expect(task.nextRunAt).toBe(target.getTime());
    ctx.services.tasks.tick();
    expect(ctx.services.tasks.runs(task.id)).toEqual([]);

    ctx.clock.now = target.getTime() + minute;
    ctx.services.tasks.tick();
    const run = await lastRun(ctx, task.id);
    expect(run).toMatchObject({ trigger: "schedule", status: "succeeded" });
    const call = ctx.agent.calls.find((c) => c.op === "services.control")!;
    expect(call.params).toEqual({ unit: "jellyfin.service", action: "restart" });
    expect(call.actor).toMatchObject({ kind: "user", username: "admin" });
    const next = new Date(target);
    next.setDate(next.getDate() + 1);
    expect(ctx.services.tasks.get(task.id)).toMatchObject({
      lastStatus: "succeeded",
      nextRunAt: next.getTime(),
    });
    expect(
      ctx.db.all<{ action: string; outcome: string }>(
        "SELECT action, outcome FROM audit_events WHERE action LIKE 'tasks.%' ORDER BY id",
      ),
    ).toEqual([
      { action: "tasks.create", outcome: "success" },
      { action: "tasks.run", outcome: "success" },
    ]);
  });

  it("reports failures and stops tasks whose owner lost the permission", async () => {
    const { ctx, admin, operator } = await withRoles();
    const missing = await json<TaskView>(
      await operator.post("/api/tasks", {
        name: "Yok",
        type: "container.restart",
        params: { container: "no-such-container" },
        schedule: "0 4 * * *",
      }),
    );
    await operator.post(`/api/tasks/${missing.id}/run`, {});
    expect(await lastRun(ctx, missing.id)).toMatchObject({
      trigger: "manual",
      status: "failed",
      error: "not-found",
    });
    const notes = await json<NotificationList>(
      await operator.get("/api/notifications?category=tasks"),
    );
    expect(notes.notifications[0]).toMatchObject({
      kind: "task-failed",
      params: { task: "Yok", reason: "not-found" },
    });

    // Demote the owner: the task no longer runs with their former rights.
    const operatorId = ctx.db.get<{ id: string }>(
      "SELECT id FROM users WHERE username = 'operator'",
    )!.id;
    await admin.patch(`/api/users/${operatorId}`, { role: "viewer" });
    await admin.post(`/api/tasks/${missing.id}/run`, {});
    expect(await lastRun(ctx, missing.id)).toMatchObject({
      status: "failed",
      error: "owner-unauthorized",
    });
  });

  it("runs on demand, refuses overlapping runs and can be cancelled", async () => {
    const { ctx, admin } = await withRoles();
    const security = await json<TaskView>(
      await admin.post("/api/tasks", {
        name: "Güvenlik",
        type: "updates.security",
        params: {},
        schedule: "0 5 * * *",
        notify: "always",
      }),
    );
    // A run that blocks until it is cancelled.
    ctx.agent.streamHandlers.set("apt.upgrade", async function* (_params, signal) {
      yield { type: "line", text: "working" };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    });
    await admin.post(`/api/tasks/${security.id}/run`, {});
    await vi.waitFor(() => expect(ctx.services.updates.jobs()[0]?.status).toBe("running"));
    expect((await admin.post(`/api/tasks/${security.id}/run`, {})).status).toBe(409);
    expect(
      await json<{ cancelled: boolean }>(await admin.post(`/api/tasks/${security.id}/cancel`, {})),
    ).toEqual({ cancelled: true });
    expect(await lastRun(ctx, security.id)).toMatchObject({ status: "cancelled" });

    ctx.agent.streamHandlers.delete("apt.upgrade");
    await admin.post(`/api/tasks/${security.id}/run`, {});
    expect(await lastRun(ctx, security.id)).toMatchObject({ status: "succeeded", summary: "2" });
    const notes = await json<NotificationList>(
      await admin.get("/api/notifications?category=tasks"),
    );
    expect(notes.notifications.some((n) => n.kind === "task-succeeded")).toBe(true);
  });

  it("catches up a recently missed run once after a restart and skips older ones", async () => {
    const { ctx, admin } = await withRoles();
    const recent = await json<TaskView>(
      await admin.post("/api/tasks", {
        name: "Yakın",
        type: "service.restart",
        params: { unit: "jellyfin.service" },
        schedule: "0 9 * * *",
      }),
    );
    const old = await json<TaskView>(
      await admin.post("/api/tasks", {
        name: "Eski",
        type: "service.restart",
        params: { unit: "jellyfin.service" },
        schedule: "0 9 * * *",
        catchUp: false,
      }),
    );
    ctx.db.run("UPDATE scheduled_tasks SET next_run_at = ?", ctx.clock.now - 60 * minute);
    ctx.db.run(
      "INSERT INTO task_runs(id, task_id, trigger, status, started_at) VALUES ('00000000-0000-4000-8000-000000000001', ?, 'schedule', 'running', ?)",
      recent.id,
      ctx.clock.now - 2 * 60 * minute,
    );
    const restarted = new TaskService({
      db: ctx.db,
      users: ctx.services.users,
      audit: ctx.services.audit,
      notifications: ctx.services.notifications,
      logger: ctx.services.logger,
      now: () => ctx.clock.now,
      executors: taskExecutors({
        agent: ctx.agent,
        updates: ctx.services.updates,
        apps: ctx.services.apps,
      }),
    });
    restarted.start();
    await vi.waitFor(() =>
      expect(restarted.runs(recent.id).find((r) => r.trigger === "catch-up")?.status).toBe(
        "succeeded",
      ),
    );
    expect(restarted.runs(recent.id).map((r) => r.status)).toContain("interrupted");
    expect(restarted.runs(old.id)).toEqual([]);
    // Skipped: the next run is simply the next 09:00.
    expect(restarted.get(old.id).nextRunAt).toBeGreaterThan(ctx.clock.now);
    expect(new Date(restarted.get(old.id).nextRunAt!).getHours()).toBe(9);
    restarted.stop();
  });

  it("lists upcoming runs for calendars, counted per day in the server's time", async () => {
    const { ctx, admin, viewer } = await withRoles();
    const start = new Date(ctx.clock.now);
    start.setHours(0, 0, 0, 0);
    const day = 24 * 60 * minute;
    await admin.post("/api/tasks", {
      name: "Gece",
      type: "service.restart",
      params: { unit: "jellyfin.service" },
      schedule: "30 3 * * *",
    });
    await admin.post("/api/tasks", {
      name: "Kapalı",
      type: "service.restart",
      params: { unit: "jellyfin.service" },
      schedule: "0 * * * *",
      enabled: false,
    });
    const from = start.getTime();
    const calendar = await json<{
      occurrences: Array<{ name: string; at: number }>;
      days: Record<string, number>;
    }>(await admin.get(`/api/tasks/calendar?from=${from}&to=${from + 3 * day}`));
    expect(calendar.occurrences.map((o) => o.name)).toEqual(["Gece", "Gece", "Gece"]);
    expect(new Date(calendar.occurrences[0]!.at).getHours()).toBe(3);
    expect(Object.values(calendar.days)).toEqual([1, 1, 1]);
    // Bounded ranges only, and only for people who manage tasks.
    expect((await admin.get(`/api/tasks/calendar?from=${from}&to=${from + 90 * day}`)).status).toBe(
      400,
    );
    expect((await viewer.get(`/api/tasks/calendar?from=${from}&to=${from + day}`)).status).toBe(
      403,
    );
  });
});
