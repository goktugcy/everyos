import type {
  ApiErrorBody,
  NotificationEvent,
  NotificationList,
  NotificationView,
  ServiceList,
} from "@otuken/shared";
import { describe, expect, it } from "vitest";
import { HostMonitor } from "./modules/notifications/host-monitor.ts";
import type { NotificationChange } from "./modules/notifications/notification-service.ts";
import { json, readEvents, sampleServices, withRoles, type TestClient } from "./test-support.ts";

const minutes = (n: number) => n * 60_000;

async function list(client: TestClient, query = "") {
  const response = await client.get(`/api/notifications${query}`);
  expect(response.status).toBe(200);
  return json<NotificationList & { unread: Partial<Record<string, number>> }>(response);
}

describe("notification service", () => {
  it("raises a condition once, alerts again only when it gets worse, and resolves it", async () => {
    const { ctx, admin } = await withRoles();
    const { notifications } = ctx.services;
    const changes: NotificationChange[] = [];
    notifications.subscribe((change) => changes.push(change));

    notifications.raise({
      kind: "storage-low",
      severity: "warning",
      key: "/",
      params: { mount: "/", percent: 91 },
    });
    notifications.raise({
      kind: "storage-low",
      severity: "warning",
      key: "/",
      params: { mount: "/", percent: 91 },
    });
    let page = await list(admin);
    expect(page.notifications).toHaveLength(1);
    expect(page.unread).toEqual({ storage: 1 });
    expect(changes.filter((c) => c.type === "changed" && c.toast)).toHaveLength(1);

    // Read it; worse news makes it unread again and alerts once more.
    await admin.post("/api/notifications/read", { all: true });
    expect((await list(admin)).unread).toEqual({});
    ctx.clock.now += minutes(5);
    notifications.raise({
      kind: "storage-low",
      severity: "critical",
      key: "/",
      params: { mount: "/", percent: 96 },
    });
    page = await list(admin);
    expect(page.notifications[0]).toMatchObject({
      severity: "critical",
      read: false,
      params: { percent: 96 },
    });
    expect(changes.filter((c) => c.type === "changed" && c.toast)).toHaveLength(2);

    // Only kinds whose check ran are cleared.
    notifications.resolveMissing(["service-failed"], new Set());
    expect((await list(admin)).notifications[0]!.resolvedAt).toBeNull();
    notifications.resolveMissing(["storage-low"], new Set());
    expect((await list(admin)).notifications[0]!.resolvedAt).toBe(ctx.clock.now);
    // A new occurrence after resolution is a new notification.
    notifications.raise({ kind: "storage-low", severity: "warning", key: "/" });
    expect((await list(admin)).notifications).toHaveLength(2);
  });

  it("merges repeated events, rate-limits re-alerts and starts over after an hour", async () => {
    const { ctx, admin } = await withRoles();
    const { notifications } = ctx.services;
    const toasts: NotificationChange[] = [];
    notifications.subscribe(
      (change) => change.type === "changed" && change.toast && toasts.push(change),
    );
    const fail = () =>
      notifications.publish({
        kind: "app-failed",
        severity: "critical",
        key: "a1:update",
        params: { app: "Demo" },
      });

    fail();
    ctx.clock.now += minutes(1);
    fail();
    let page = await list(admin);
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]!.count).toBe(2);
    expect(toasts).toHaveLength(1);

    ctx.clock.now += minutes(20);
    fail();
    expect(toasts).toHaveLength(2);
    ctx.clock.now += minutes(61);
    fail();
    page = await list(admin);
    expect(page.notifications.map((n) => n.count)).toEqual([1, 3]);
  });

  it("shows each user only what their permissions allow, with per-user read state", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    const { notifications } = ctx.services;
    notifications.publish({
      kind: "backup-failed",
      severity: "critical",
      params: { reason: "disk-full" },
    });
    notifications.publish({
      kind: "login-locked",
      severity: "warning",
      key: "user:x",
      params: { username: "x" },
    });
    notifications.raise({
      kind: "service-failed",
      severity: "critical",
      key: "a.service",
      params: { unit: "a.service" },
    });

    const kinds = async (client: TestClient) =>
      (await list(client)).notifications.map((n) => n.kind).sort();
    expect(await kinds(admin)).toEqual(["backup-failed", "login-locked", "service-failed"]);
    expect(await kinds(operator)).toEqual(["backup-failed", "service-failed"]);
    expect(await kinds(viewer)).toEqual(["service-failed"]);

    const service = (await list(viewer)).notifications[0]!;
    // Read/dismiss of a notification someone cannot see is a no-op, not a leak.
    const hidden = (await list(admin)).notifications.find((n) => n.kind === "login-locked")!;
    await viewer.post("/api/notifications/dismiss", { ids: [hidden.id] });
    expect(await kinds(admin)).toContain("login-locked");

    await viewer.post("/api/notifications/read", { ids: [service.id] });
    expect((await list(viewer)).unread).toEqual({});
    expect((await list(operator)).unread).toEqual({ backups: 1, services: 1 });
    await operator.post("/api/notifications/dismiss", { ids: [service.id] });
    expect(await kinds(operator)).toEqual(["backup-failed"]);
    expect(await kinds(viewer)).toEqual(["service-failed"]);

    // Filters, unread view and "mark all".
    expect((await list(admin, "?category=security")).notifications).toHaveLength(1);
    expect((await list(admin, "?severity=critical")).notifications).toHaveLength(2);
    await admin.post("/api/notifications/read", { all: true });
    expect((await list(admin, "?unread=true")).notifications).toHaveLength(0);
    await admin.post("/api/notifications/unread", { ids: [service.id] });
    expect((await list(admin)).unread).toEqual({ services: 1 });

    // Notifications for one user only.
    const operatorId = ctx.db.get<{ id: string }>(
      "SELECT id FROM users WHERE username = 'operator'",
    )!.id;
    notifications.publish({
      kind: "task-failed",
      severity: "warning",
      userId: operatorId,
      params: { task: "t" },
    });
    expect(await kinds(operator)).toContain("task-failed");
    expect(await kinds(admin)).not.toContain("task-failed");
  });

  it("validates requests and requires the permission", async () => {
    const { admin } = await withRoles();
    const bad = await admin.post("/api/notifications/read", { ids: ["not-a-uuid"] });
    expect(bad.status).toBe(400);
    expect((await json<ApiErrorBody>(bad)).error.code).toBe("VALIDATION_FAILED");
    expect((await admin.get("/api/notifications?limit=1000")).status).toBe(400);
  });

  it("pages through notifications", async () => {
    const { ctx, admin } = await withRoles();
    for (let i = 0; i < 5; i++) {
      ctx.clock.now += 1_000;
      ctx.services.notifications.publish({
        kind: "task-succeeded",
        severity: "success",
        key: `t${i}`,
        params: { task: `t${i}` },
      });
    }
    const first = await list(admin, "?limit=3");
    expect(first.notifications.map((n) => n.params.task)).toEqual(["t4", "t3", "t2"]);
    const second = await list(admin, `?limit=3&before=${first.nextCursor}`);
    expect(second.notifications.map((n) => n.params.task)).toEqual(["t1", "t0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("prunes old and excess notifications but keeps open conditions", async () => {
    const { ctx } = await withRoles();
    const { notifications } = ctx.services;
    notifications.raise({ kind: "service-failed", severity: "critical", key: "x" });
    notifications.publish({ kind: "app-succeeded", severity: "success" });
    ctx.clock.now += 31 * 24 * 60 * 60_000;
    expect(notifications.prune()).toBe(1);
    expect(ctx.db.all<{ kind: string }>("SELECT kind FROM notifications")).toEqual([
      { kind: "service-failed" },
    ]);
  });
});

describe("notification sources", () => {
  it("streams counts and new notifications to permitted users", async () => {
    const { ctx, admin, viewer } = await withRoles();
    const stream = await admin.get("/api/events?topics=notifications");
    expect(stream.status).toBe(200);
    const viewerStream = await viewer.get("/api/events?topics=notifications");
    setTimeout(() => {
      ctx.services.notifications.publish({
        kind: "login-locked",
        severity: "warning",
        params: { username: "x" },
      });
      ctx.services.notifications.raise({
        kind: "service-failed",
        severity: "critical",
        key: "a",
        params: { unit: "a" },
      });
    }, 50);
    const { events } = await readEvents(stream, 4);
    const messages = events
      .filter((e) => e.event === "notifications")
      .map((e) => e.data as NotificationEvent);
    expect(messages[0]).toEqual({ unread: {}, latest: null });
    expect(messages.map((m) => m.latest?.kind)).toEqual([
      undefined,
      "login-locked",
      "service-failed",
    ]);
    expect(messages.at(-1)!.unread).toEqual({ security: 1, services: 1 });

    // Viewers never receive the security notification, not even as a count.
    const { events: viewerEvents } = await readEvents(viewerStream, 3);
    const viewerMessages = viewerEvents
      .filter((e) => e.event === "notifications")
      .map((e) => e.data as NotificationEvent);
    expect(viewerMessages.map((m) => m.latest?.kind)).toEqual([undefined, "service-failed"]);
    expect(JSON.stringify(viewerMessages)).not.toContain("login-locked");
  });

  it("notifies administrators about login lockouts", async () => {
    const { ctx, admin, operator } = await withRoles();
    const attacker = new (admin.constructor as typeof TestClient)(ctx, "203.0.113.7");
    for (let i = 0; i < 6; i++) await attacker.login("operator", "wrong-password-123");
    const locked = (await list(admin)).notifications.filter((n) => n.kind === "login-locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]!.params).toMatchObject({ username: "operator", scope: "user" });
    expect((await list(operator)).notifications.some((n) => n.kind === "login-locked")).toBe(false);
  });

  it("raises and resolves host conditions from real checks only", async () => {
    const { ctx, admin } = await withRoles();
    const monitor = new HostMonitor({
      agent: ctx.agent,
      notifications: ctx.services.notifications,
      logger: ctx.services.logger,
    });
    const failed: ServiceList = {
      ...sampleServices,
      units: sampleServices.units.map((u) =>
        u.name === "jellyfin.service" ? { ...u, active: "failed", sub: "failed" } : u,
      ),
    };
    ctx.agent.handlers.set("services.list", () => failed);
    ctx.agent.handlers.set("network.status", () => ({
      source: "host",
      interfaces: [],
      gateways: [],
      dns: [],
      internet: { state: "offline", checkedAt: 1, latencyMs: null },
    }));
    await monitor.check();
    const kinds = async () =>
      (await list(admin)).notifications
        .filter((n) => n.resolvedAt === null)
        .map((n: NotificationView) => n.kind)
        .sort();
    // The simulated Docker has an unhealthy container and apt one security update.
    expect(await kinds()).toEqual(["container-unhealthy", "security-updates", "service-failed"]);
    // Internet loss must persist across two checks.
    await monitor.check();
    expect(await kinds()).toContain("internet-offline");

    // A failing check does not clear the problem; a real recovery does.
    ctx.agent.handlers.set("services.list", () => {
      throw new Error("boom");
    });
    await monitor.check();
    expect(await kinds()).toContain("service-failed");
    ctx.agent.handlers.set("services.list", () => sampleServices);
    ctx.agent.handlers.delete("network.status");
    await monitor.check();
    expect(await kinds()).toEqual(["container-unhealthy", "security-updates"]);

    // The agent being unreachable for two checks is a critical condition.
    ctx.agent.state = "disconnected";
    await monitor.check();
    await monitor.check();
    expect(await kinds()).toContain("agent-unavailable");
    ctx.agent.state = "connected";
    await monitor.check();
    expect(await kinds()).not.toContain("agent-unavailable");
    monitor.stop();
  });
});
