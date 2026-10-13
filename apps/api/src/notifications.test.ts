import type {
  ApiErrorBody,
  NotificationEvent,
  NotificationList,
  NotificationView,
  ServiceList,
  SelfUpdateStatus,
} from "@everyos/shared";
import { describe, expect, it, vi } from "vitest";
import { ReleaseMonitor } from "./modules/notifications/release-monitor.ts";
import { HostMonitor } from "./modules/notifications/host-monitor.ts";
import type { NotificationChange } from "./modules/notifications/notification-service.ts";
import { json, readEvents, sampleServices, withRoles, TestClient } from "./test-support.ts";

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

describe("EveryOS release notifications", () => {
  const status = (now: number, version: string | null = "0.1.7"): SelfUpdateStatus => ({
    source: "host",
    installedVersion: "0.1.6",
    architecture: "arm64",
    configured: true,
    reason: null,
    checkedAt: now,
    available: version
      ? {
          version,
          minVersion: "0.1.0",
          schemaVersion: 1,
          notes: "Fixture release",
          publishedAt: now,
        }
      : null,
    job: null,
  });

  it("the scheduled production monitor discovers a new release after an hour and emits one automatic toast", async () => {
    const { ctx, admin } = await withRoles();
    let candidate: string | null = null;
    let cached: SelfUpdateStatus = { ...status(ctx.clock.now, null), checkedAt: null };
    const changes: NotificationChange[] = [];
    const unsubscribe = ctx.services.notifications.subscribe((change) => changes.push(change));
    ctx.agent.handlers.set("release.status", () => cached);
    ctx.agent.handlers.set("release.check", () => {
      cached = status(ctx.clock.now, candidate);
      return cached;
    });
    const monitor = ctx.services.releaseMonitor;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ctx.agent.calls.filter((call) => call.op === "release.check")).toHaveLength(1);
      expect((await list(admin, "?category=updates")).notifications).toHaveLength(0);
      candidate = "0.1.8";
      ctx.clock.now += minutes(59);
      await vi.advanceTimersByTimeAsync(minutes(59));
      expect(ctx.agent.calls.filter((call) => call.op === "release.check")).toHaveLength(1);
      ctx.clock.now += minutes(1);
      await vi.advanceTimersByTimeAsync(minutes(1));
      expect(ctx.agent.calls.filter((call) => call.op === "release.check")).toHaveLength(2);
      expect((await list(admin, "?category=updates")).notifications[0]).toMatchObject({
        kind: "everyos-update-available",
        params: { version: "0.1.8" },
      });
      ctx.clock.now += minutes(1);
      await vi.advanceTimersByTimeAsync(minutes(1));
      expect(changes.filter((change) => change.type === "changed" && change.toast)).toHaveLength(1);
      expect(ctx.agent.calls.some((call) => call.op === "release.install")).toBe(false);
      monitor.stop();
      const calls = ctx.agent.calls.length;
      await vi.advanceTimersByTimeAsync(minutes(60));
      expect(ctx.agent.calls).toHaveLength(calls);
    } finally {
      monitor.stop();
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("streams verified release snapshots and changes to authenticated readers without a page refresh", async () => {
    const { ctx, admin, viewer } = await withRoles();
    let cached = status(ctx.clock.now, null);
    ctx.agent.handlers.set("release.status", () => cached);
    ctx.services.releaseMonitor.observe(cached);
    expect((await new TestClient(ctx).get("/api/events?topics=release")).status).toBe(401);
    const response = await admin.get("/api/events?topics=release");
    setTimeout(() => {
      cached = status(++ctx.clock.now, "0.1.8");
      ctx.services.releaseMonitor.observe(cached);
      ctx.services.releaseMonitor.observe(cached);
      cached = { ...cached, installedVersion: "0.1.8", available: null };
      ctx.services.releaseMonitor.observe(cached);
    }, 30);
    const { events, reader } = await readEvents(response, 4);
    await reader.cancel();
    const statuses = events
      .filter((event) => event.event === "release.status")
      .map((event) => event.data as SelfUpdateStatus);
    expect(statuses).toHaveLength(3);
    expect(statuses.map((s) => s.available?.version ?? null)).toEqual([null, "0.1.8", null]);
    expect(statuses[2]?.installedVersion).toBe("0.1.8");
    const replay = await readEvents(await viewer.get("/api/events?topics=release"), 2);
    await replay.reader.cancel();
    expect(replay.events[1]?.data).toEqual(cached);
    expect(ctx.agent.calls.some((call) => call.op === "release.install")).toBe(false);
  });

  it("manual checks publish a visible update once and preserve read state across checks and monitor restarts", async () => {
    const { ctx, admin, viewer } = await withRoles();
    const current = status(ctx.clock.now);
    ctx.agent.handlers.set("release.check", () => current);
    expect((await admin.post("/api/self-update/check", {})).status).toBe(200);
    let page = await list(viewer, "?category=updates");
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]).toMatchObject({
      kind: "everyos-update-available",
      severity: "warning",
      params: { version: "0.1.7", installedVersion: "0.1.6" },
    });
    await viewer.post("/api/notifications/read", { all: true });
    await admin.post("/api/self-update/check", {});
    const restarted = new ReleaseMonitor({
      agent: ctx.agent,
      notifications: ctx.services.notifications,
      logger: ctx.services.logger,
      now: () => ctx.clock.now,
    });
    restarted.observe(current);
    page = await list(viewer, "?category=updates");
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]?.read).toBe(true);
    restarted.observe({ ...current, installedVersion: "0.1.7", available: null });
    expect((await list(viewer, "?category=updates")).notifications[0]?.resolvedAt).toBe(
      ctx.clock.now,
    );
    restarted.observe(status(ctx.clock.now, "0.1.8"));
    expect((await list(viewer, "?category=updates")).unread).toEqual({ updates: 1 });
  });

  it("checks in the background without a browser, coalesces checks and respects hourly refresh and retry backoff", async () => {
    const { ctx, admin } = await withRoles();
    let cached: SelfUpdateStatus = { ...status(ctx.clock.now, null), checkedAt: null };
    let fail = false;
    ctx.agent.handlers.set("release.status", () => cached);
    ctx.agent.handlers.set("release.check", () => {
      if (fail) throw new Error("Fixture signature rejection");
      cached = status(ctx.clock.now);
      return cached;
    });
    const monitor = ctx.services.releaseMonitor;
    await Promise.all([monitor.check(), monitor.check()]);
    expect(ctx.agent.calls.filter((c) => c.op === "release.check")).toHaveLength(1);
    expect(ctx.agent.calls.find((c) => c.op === "release.check")?.actor).toEqual({
      kind: "system",
      component: "release-monitor",
    });
    expect((await list(admin, "?category=updates")).notifications).toHaveLength(1);
    ctx.clock.now += minutes(59);
    await monitor.check();
    expect(ctx.agent.calls.filter((c) => c.op === "release.check")).toHaveLength(1);
    ctx.clock.now += minutes(2);
    fail = true;
    await monitor.check();
    expect(ctx.agent.calls.filter((c) => c.op === "release.check")).toHaveLength(2);
    ctx.clock.now += minutes(1);
    await monitor.check();
    expect(ctx.agent.calls.filter((c) => c.op === "release.check")).toHaveLength(2);
    expect((await list(admin, "?category=updates")).notifications[0]?.resolvedAt).toBeNull();
    ctx.clock.now += minutes(15);
    fail = false;
    await monitor.check();
    expect(ctx.agent.calls.filter((c) => c.op === "release.check")).toHaveLength(3);
    expect(ctx.agent.calls.some((c) => c.op === "release.install")).toBe(false);
    monitor.stop();
    await monitor.check();
    expect(ctx.agent.calls.filter((c) => c.op === "release.check")).toHaveLength(3);
  });

  it("does not invent releases from failed, unconfigured or non-newer checks", async () => {
    const { ctx, admin } = await withRoles();
    ctx.agent.handlers.set("release.status", () => ({
      ...status(ctx.clock.now, null),
      checkedAt: null,
    }));
    ctx.agent.handlers.set("release.check", () => {
      throw new Error("Fixture signature rejection");
    });
    await ctx.services.releaseMonitor.check();
    expect((await list(admin)).notifications).toHaveLength(0);
    ctx.services.releaseMonitor.observe(status(ctx.clock.now, "0.1.5"));
    ctx.services.releaseMonitor.observe({
      ...status(ctx.clock.now),
      configured: false,
      reason: "not-configured",
    });
    expect((await list(admin)).notifications).toHaveLength(0);
  });
});
