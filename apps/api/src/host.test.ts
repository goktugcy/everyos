import type {
  ApiErrorBody,
  AuditPage,
  LogPage,
  MetricsHistory,
  MetricsSnapshot,
  ServiceList,
} from "@otuken/shared";
import { AgentClientError } from "@otuken/agent-protocol";
import { silentLogger } from "@otuken/logger";
import { describe, expect, it } from "vitest";
import { MetricsHub } from "./modules/metrics/metrics-hub.ts";
import { computePoint, computeSnapshot, downsample } from "./modules/metrics/rates.ts";
import {
  completeSetup,
  createTestContext,
  FakeAgent,
  json,
  sampleMetrics,
  STRONG_PASSWORD,
  TestClient,
} from "./test-support.ts";

const errorCode = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

async function withRoles() {
  const ctx = await createTestContext();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  const users: Record<"operator" | "viewer", TestClient> = {} as never;
  for (const role of ["operator", "viewer"] as const) {
    await admin.post("/api/users", {
      username: role,
      displayName: role,
      password: STRONG_PASSWORD,
      role,
    });
    const client = new TestClient(ctx, role === "operator" ? "192.0.2.10" : "192.0.2.11");
    expect((await client.login(role, STRONG_PASSWORD)).status).toBe(200);
    users[role] = client;
  }
  return { ctx, admin, ...users };
}

/** Reads server-sent events until `count` events (other than comments) arrived. */
async function readEvents(response: Response, count: number, timeoutMs = 2_000) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: unknown }> = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.max(1, deadline - Date.now()),
        ),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) events.push({ event, data: data ? (JSON.parse(data) as unknown) : null });
      index = buffer.indexOf("\n\n");
    }
  }
  return { events, reader };
}

async function streamEnds(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk === null) return false;
    if (chunk.done) return true;
  }
  return false;
}

describe("metric rates", () => {
  it("derives CPU, network and disk rates from raw counters", () => {
    const point = computePoint(sampleMetrics(1, 0), sampleMetrics(2, 2_000));
    expect(point).toMatchObject({
      at: 2_000,
      cpuPercent: 33.3,
      memoryUsedBytes: 2_000_000_000,
      // Only physical NICs count: loopback and bridge traffic is excluded.
      netRxBytesPerSec: 1_000,
      netTxBytesPerSec: 500,
      diskReadBytesPerSec: 2_048,
      diskWriteBytesPerSec: 4_096,
      temperatureC: 48.5,
    });
  });

  it("reports unknown instead of negative rates when counters reset", () => {
    const point = computePoint(sampleMetrics(5, 0), sampleMetrics(1, 2_000));
    expect(point.cpuPercent).toBeNull();
    expect(point.netRxBytesPerSec).toBeNull();
    expect(computePoint(null, sampleMetrics(1, 0)).cpuPercent).toBeNull();
  });

  it("computes per-core, per-interface and per-disk detail", () => {
    const snapshot = computeSnapshot(sampleMetrics(1, 0), sampleMetrics(2, 1_000));
    expect(snapshot.cpuCores).toEqual([33.3, 33.3]);
    expect(snapshot.interfaces).toContainEqual({
      name: "eth0",
      rxBytesPerSec: 2_000,
      txBytesPerSec: 1_000,
    });
    expect(snapshot.disks).toEqual([
      { name: "nvme0n1", readBytesPerSec: 4_096, writeBytesPerSec: 8_192, busyPercent: 10 },
    ]);
  });

  it("averages long ranges into buckets", () => {
    const base = computePoint(null, sampleMetrics(1, 0));
    const points = [0, 60_000, 120_000, 300_000].map((at, i) => ({
      ...base,
      at,
      cpuPercent: i * 10,
    }));
    const buckets = downsample(points, 300_000);
    expect(buckets.map((p) => [p.at, p.cpuPercent])).toEqual([
      [0, 10],
      [300_000, 30],
    ]);
  });
});

describe("metrics hub", () => {
  it("samples quickly only while someone is watching", async () => {
    const agent = new FakeAgent();
    const hub = new MetricsHub({
      agent,
      logger: silentLogger,
      liveIntervalMs: 10,
      historyIntervalMs: 60_000,
    });
    const received: MetricsSnapshot[] = [];
    const unsubscribe = hub.subscribe((snapshot) => received.push(snapshot));
    await expect.poll(() => received.length).toBeGreaterThanOrEqual(3);
    unsubscribe();
    const calls = agent.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.calls.length).toBe(calls);
    expect(agent.calls.every((call) => call.actor.kind === "system")).toBe(true);
    hub.stop();
  });

  it("keeps bounded minute-averaged history", async () => {
    const agent = new FakeAgent();
    let now = 0;
    agent.now = () => now;
    const hub = new MetricsHub({ agent, logger: silentLogger, now: () => now });
    for (let minute = 0; minute <= 26 * 60; minute++) {
      now = minute * 60_000;
      await hub.sample();
    }
    const day = hub.history("24h");
    expect(day.points.length).toBeLessThanOrEqual(289);
    expect(day.points[0]!.at).toBeGreaterThanOrEqual(now - 24 * 3_600_000 - 5 * 60_000);
    expect(hub.history("1h").points.length).toBeLessThanOrEqual(61);
    expect(hub.history("15m").points.length).toBeLessThanOrEqual(16);
    expect(day.points.at(-1)!.cpuPercent).toBe(33.3);
  });

  it("skips samples while the agent is down", async () => {
    const agent = new FakeAgent();
    agent.state = "disconnected";
    const hub = new MetricsHub({ agent, logger: silentLogger });
    await hub.sample();
    expect(agent.calls).toHaveLength(0);
    expect(hub.latest).toBeNull();
  });
});

describe("system endpoints", () => {
  it("serves host data to every role with system:read", async () => {
    const { viewer } = await withRoles();
    for (const path of ["storage", "hardware", "network", "tailscale", "processes"]) {
      const response = await viewer.get(`/api/system/${path}`);
      expect(response.status, path).toBe(200);
    }
    expect((await viewer.get("/api/system/processes?limit=9999")).status).toBe(400);
    expect((await viewer.get("/api/system/processes?sort=name")).status).toBe(400);
  });

  it("requires a session", async () => {
    const ctx = await createTestContext();
    const anonymous = new TestClient(ctx);
    expect((await anonymous.get("/api/system/storage")).status).toBe(401);
  });

  it("returns live metrics and history", async () => {
    const { ctx, viewer } = await withRoles();
    await ctx.services.metrics.sample();
    ctx.clock.now += 2_000;
    await ctx.services.metrics.sample();
    const response = await viewer.get("/api/system/metrics");
    expect(response.status).toBe(200);
    const snapshot = await json<MetricsSnapshot>(response);
    expect(snapshot.source).toBe("host");
    expect(snapshot.point.cpuPercent).toBe(33.3);
    const history = await json<MetricsHistory>(
      await viewer.get("/api/system/metrics/history?range=15m"),
    );
    expect(history.points.length).toBe(2);
    expect((await viewer.get("/api/system/metrics/history?range=7d")).status).toBe(400);
  });

  it("maps agent errors to stable API errors", async () => {
    const { ctx, viewer } = await withRoles();
    ctx.agent.state = "disconnected";
    const response = await viewer.get("/api/system/storage");
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("AGENT_UNAVAILABLE");
  });
});

describe("services API", () => {
  async function auditActions(admin: TestClient) {
    const page = await json<AuditPage>(await admin.get("/api/audit?limit=50"));
    return page.events.filter((event) => event.action.startsWith("services."));
  }

  it("lets viewers read but not change services", async () => {
    const { viewer } = await withRoles();
    const list = await json<ServiceList>(await viewer.get("/api/services"));
    expect(list.units.find((unit) => unit.name === "ssh.service")?.protected).toBe(true);
    expect((await viewer.get("/api/services/jellyfin.service")).status).toBe(200);
    const response = await viewer.post("/api/services/jellyfin.service/actions", {
      action: "start",
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });

  it("forwards operator actions to the agent and audits them", async () => {
    const { ctx, admin, operator } = await withRoles();
    const response = await operator.post("/api/services/jellyfin.service/actions", {
      action: "restart",
    });
    expect(response.status).toBe(202);
    expect(ctx.agent.calls.at(-1)).toMatchObject({
      op: "services.control",
      params: { unit: "jellyfin.service", action: "restart" },
      actor: { kind: "user", username: "operator", role: "operator" },
    });
    expect(await auditActions(admin)).toContainEqual(
      expect.objectContaining({
        action: "services.restart",
        target: "jellyfin.service",
        outcome: "success",
      }),
    );
  });

  it("surfaces agent policy denials and audits them", async () => {
    const { admin } = await withRoles();
    const response = await admin.post("/api/services/ssh.service/actions", { action: "stop" });
    expect(response.status).toBe(403);
    const body = await json<ApiErrorBody>(response);
    expect(body.error.code).toBe("AGENT_OPERATION_DENIED");
    expect(body.error.details).toEqual({ reason: expect.stringContaining("protected") as string });
    expect(await auditActions(admin)).toContainEqual(
      expect.objectContaining({
        action: "services.stop",
        target: "ssh.service",
        outcome: "denied",
      }),
    );
  });

  it("validates unit names and actions before reaching the agent", async () => {
    const { ctx, admin } = await withRoles();
    const before = ctx.agent.calls.length;
    for (const unit of ["..%2F..%2Fetc%2Fpasswd", "ssh", "-H%20evil.service", "a%20b.service"]) {
      expect((await admin.get(`/api/services/${unit}`)).status, unit).toBe(400);
    }
    expect(
      (await admin.post("/api/services/nginx.service/actions", { action: "mask" })).status,
    ).toBe(400);
    expect(
      (await admin.post("/api/services/nginx.service/actions", { action: "start", extra: 1 }))
        .status,
    ).toBe(400);
    expect(ctx.agent.calls.length).toBe(before);
  });

  it("returns 404 for unknown units and 501 without systemd", async () => {
    const { ctx, admin } = await withRoles();
    expect((await admin.get("/api/services/missing.service")).status).toBe(404);
    ctx.agent.handlers.set("services.list", () => {
      throw new AgentClientError(
        "AGENT_OPERATION_FAILED",
        "systemd is not available",
        "unsupported",
      );
    });
    const response = await admin.get("/api/services");
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe("HOST_CAPABILITY_UNAVAILABLE");
  });
});

describe("logs API", () => {
  it("requires logs:read", async () => {
    const { viewer, operator } = await withRoles();
    expect((await viewer.get("/api/logs")).status).toBe(403);
    expect((await viewer.get("/api/logs/stream")).status).toBe(403);
    const page = await json<LogPage>(
      await operator.get("/api/logs?unit=ssh.service&priority=4&limit=50"),
    );
    expect(page.entries).toHaveLength(2);
  });

  it("validates filters", async () => {
    const { operator } = await withRoles();
    expect((await operator.get("/api/logs?priority=9")).status).toBe(400);
    expect((await operator.get("/api/logs?unit=..%2Fx")).status).toBe(400);
    expect((await operator.get("/api/logs?limit=5000")).status).toBe(400);
    expect((await operator.get(`/api/logs?grep=${"a".repeat(300)}`)).status).toBe(400);
  });

  it("streams live entries and cancels the agent stream on disconnect", async () => {
    const { ctx, operator } = await withRoles();
    const response = await operator.get("/api/logs/stream?unit=ssh.service");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const { events, reader } = await readEvents(response, 3);
    expect(events.map((e) => e.event)).toEqual(["ready", "entry", "entry"]);
    expect(ctx.agent.calls.at(-1)).toMatchObject({
      op: "logs.follow",
      params: { unit: "ssh.service" },
    });
    await reader.cancel();
  });
});

describe("event stream", () => {
  it("pushes live metrics to subscribers", async () => {
    const { ctx, viewer } = await withRoles();
    ctx.services.metrics.subscribe(() => undefined)();
    const response = await viewer.get("/api/events?topics=metrics");
    expect(response.status).toBe(200);
    const { events, reader } = await readEvents(response, 2);
    expect(events[0]?.event).toBe("ready");
    expect(events[1]).toMatchObject({ event: "metrics", data: { source: "host" } });
    await reader.cancel();
    await expect.poll(() => ctx.services.metrics.subscriberCount).toBe(0);
  });

  it("rejects unknown topics, anonymous clients and locked sessions", async () => {
    const { ctx, viewer } = await withRoles();
    expect((await viewer.get("/api/events?topics=secrets")).status).toBe(400);
    expect((await viewer.get("/api/events")).status).toBe(400);
    expect((await new TestClient(ctx).get("/api/events?topics=metrics")).status).toBe(401);
    expect((await viewer.post("/api/auth/lock")).status).toBe(204);
    expect((await viewer.get("/api/events?topics=metrics")).status).toBe(423);
  });

  it("closes open streams when the session gets locked", async () => {
    const { ctx, operator } = await withRoles();
    ctx.services.eventStreamHeartbeatMs = 20;
    const response = await operator.get("/api/logs/stream");
    const { reader } = await readEvents(response, 1);
    expect((await operator.post("/api/auth/lock")).status).toBe(204);
    expect(await streamEnds(reader)).toBe(true);
  });
});
