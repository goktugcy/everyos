import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { silentLogger } from "@otuken/logger";
import type { ApiErrorBody, IntegrationView, Permission, TopicMessage } from "@otuken/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseKumaMetrics } from "./modules/integrations/adapters.ts";
import { DataHub, type DataProvider } from "./modules/widgets/data-hub.ts";
import { json, readEvents, withRoles, type TestClient } from "./test-support.ts";

const errorCode = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

/* ------------------------------- data hub ------------------------------- */

describe("data hub", () => {
  const all = new Set<Permission>(["system:read", "services:read"]);

  function counting(overrides: Partial<DataProvider> = {}) {
    let calls = 0;
    const provider: DataProvider = {
      topic: "data.test",
      permissions: ["system:read"],
      intervalMs: 60_000,
      collect: () => {
        calls++;
        return Promise.resolve({ status: "ok", data: { n: calls } });
      },
      ...overrides,
    };
    return { provider, calls: () => calls };
  }

  it("shares one collector between subscribers and stops without them", async () => {
    const { provider, calls } = counting();
    const hub = new DataHub({ logger: silentLogger, providers: [provider] });
    const a: TopicMessage[] = [];
    const b: TopicMessage[] = [];
    const stopA = hub.subscribe("data.test", all, (m) => a.push(m));
    await expect.poll(() => a.length).toBe(1);
    const stopB = hub.subscribe("data.test", all, (m) => b.push(m));
    // The second subscriber gets the cached value immediately, without another collection.
    expect(b).toEqual([expect.objectContaining({ status: "ok", data: { n: 1 } })]);
    expect(calls()).toBe(1);
    stopA();
    stopB();
    expect(hub.activeTopics).toBe(0);
  });

  it("checks permissions per subscriber and filters shared data", async () => {
    const hub = new DataHub({
      logger: silentLogger,
      providers: [
        {
          topic: "data.alerts",
          permissions: ["system:read"],
          intervalMs: 60_000,
          collect: () => Promise.resolve({ status: "ok", data: ["public", "secret"] }),
          view: (data, permissions) =>
            permissions.has("services:read")
              ? data
              : (data as string[]).filter((x) => x !== "secret"),
        },
      ],
    });
    const limited: TopicMessage[] = [];
    const full: TopicMessage[] = [];
    const denied: TopicMessage[] = [];
    hub.subscribe("data.alerts", new Set<Permission>(["system:read"]), (m) => limited.push(m));
    hub.subscribe("data.alerts", all, (m) => full.push(m));
    hub.subscribe("data.alerts", new Set<Permission>(), (m) => denied.push(m));
    hub.subscribe("data.nope", all, (m) => denied.push(m));
    await expect.poll(() => full.length).toBe(1);
    expect(limited[0]).toMatchObject({ data: ["public"] });
    expect(full[0]).toMatchObject({ data: ["public", "secret"] });
    expect(denied.map((m) => (m.status === "error" ? m.code : m.status))).toEqual([
      "FORBIDDEN",
      "NOT_FOUND",
    ]);
    hub.stop();
  });

  it("keeps unsubscribe working after a topic is invalidated", async () => {
    const { provider, calls } = counting();
    const hub = new DataHub({ logger: silentLogger, providers: [provider] });
    const messages: TopicMessage[] = [];
    const stop = hub.subscribe("data.test", all, (m) => messages.push(m));
    await expect.poll(() => messages.length).toBe(1);
    hub.invalidate("data.test");
    await expect.poll(() => messages.length).toBe(2);
    expect(calls()).toBe(2);
    stop();
    expect(hub.activeTopics).toBe(0);
  });
});

describe("Uptime Kuma metrics", () => {
  it("keeps monitor names and states, never URLs", () => {
    const parsed = parseKumaMetrics(
      [
        "# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)",
        'monitor_status{monitor_name="Jellyfin",monitor_type="http",monitor_url="http://10.0.0.5:8096",monitor_hostname="null",monitor_port="null"} 1',
        'monitor_status{monitor_name="NAS",monitor_type="ping",monitor_url="https://",monitor_hostname="10.0.0.9",monitor_port="null"} 0',
        'monitor_response_time{monitor_name="Jellyfin",monitor_type="http",monitor_url="http://10.0.0.5:8096",monitor_hostname="null",monitor_port="null"} 42',
      ].join("\n"),
    );
    expect(parsed).toEqual({
      up: 1,
      down: 1,
      pending: 0,
      maintenance: 0,
      monitors: [
        { name: "Jellyfin", type: "http", status: "up", responseMs: 42 },
        { name: "NAS", type: "ping", status: "down", responseMs: null },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("10.0.0");
  });
});

/* ------------------------------ fake apps ------------------------------ */

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) await new Promise((resolve) => servers.pop()!.close(resolve));
});

async function fakeApp(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function jellyfin() {
  return fakeApp((req, res) => {
    const token = /Token="([^"]+)"/.exec(req.headers.authorization ?? "")?.[1];
    if (req.url === "/System/Info/Public")
      return send(res, 200, { ServerName: "media", Version: "10.11.0" });
    if (token !== "jf-secret") return send(res, 401, {});
    if (req.url?.startsWith("/Sessions"))
      return send(res, 200, [
        {
          UserName: "ayse",
          Client: "Jellyfin Web",
          DeviceName: "Firefox",
          NowPlayingItem: {
            Name: "Pilot",
            SeriesName: "Show",
            Type: "Episode",
            RunTimeTicks: 1000,
          },
          PlayState: { PositionTicks: 250, IsPaused: false },
          RemoteEndPoint: "192.168.1.50",
        },
        { UserName: "idle", Client: "Android", DeviceName: "Phone" },
      ]);
    if (req.url === "/Items/Counts")
      return send(res, 200, { MovieCount: 12, SeriesCount: 3, EpisodeCount: 40 });
    return send(res, 404, {});
  });
}

async function createIntegration(client: TestClient, body: Record<string, unknown>) {
  const response = await client.post("/api/integrations", body);
  if (response.status !== 201)
    throw new Error(`create failed ${response.status} ${await response.text()}`);
  return json<IntegrationView>(response);
}

describe("integrations API", () => {
  it("lets operators create integrations and never returns credentials", async () => {
    const { admin, operator, viewer } = await withRoles();
    const baseUrl = await jellyfin();
    expect(
      (
        await viewer.post("/api/integrations", {
          adapter: "jellyfin",
          name: "Media",
          baseUrl,
          secret: "x",
        })
      ).status,
    ).toBe(403);
    const created = await createIntegration(operator, {
      adapter: "jellyfin",
      name: "Media",
      baseUrl,
      secret: "jf-secret",
    });
    expect(created).toMatchObject({
      adapter: "jellyfin",
      audience: "managers",
      hasCredentials: true,
    });
    expect(JSON.stringify(created)).not.toContain("jf-secret");
    const listed = await json<{ integrations: IntegrationView[] }>(
      await admin.get("/api/integrations"),
    );
    expect(JSON.stringify(listed)).not.toContain("jf-secret");
    // Managers-only data is hidden from viewers until shared.
    expect(
      (await json<{ integrations: IntegrationView[] }>(await viewer.get("/api/integrations")))
        .integrations,
    ).toEqual([]);
    await operator.patch(`/api/integrations/${created.id}`, { audience: "everyone" });
    expect(
      (await json<{ integrations: IntegrationView[] }>(await viewer.get("/api/integrations")))
        .integrations,
    ).toHaveLength(1);
    const audit = (
      await json<{ events: Array<{ action: string; outcome: string }> }>(
        await admin.get("/api/audit?limit=20"),
      )
    ).events;
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(["integrations.create", "integrations.update"]),
    );
  });

  it("tests connections and reports credential and network problems", async () => {
    const { operator } = await withRoles();
    const baseUrl = await jellyfin();
    const good = await createIntegration(operator, {
      adapter: "jellyfin",
      name: "Good",
      baseUrl,
      secret: "jf-secret",
    });
    const wrong = await createIntegration(operator, {
      adapter: "jellyfin",
      name: "Wrong",
      baseUrl,
      secret: "nope",
    });
    const offline = await createIntegration(operator, {
      adapter: "jellyfin",
      name: "Off",
      baseUrl: "http://127.0.0.1:9",
      secret: "x",
    });
    const metadata = await createIntegration(operator, {
      adapter: "jellyfin",
      name: "Meta",
      baseUrl: "http://169.254.169.254",
      secret: "x",
    });
    const test = async (id: string) =>
      json(await operator.post(`/api/integrations/${id}/test`, {}));
    expect(await test(good.id)).toEqual({ status: "ok" });
    expect(await test(wrong.id)).toEqual({ status: "unavailable", reason: "auth-failed" });
    expect(await test(offline.id)).toEqual({ status: "unavailable", reason: "app-offline" });
    // Cloud metadata / link-local addresses are never contacted.
    expect(await test(metadata.id)).toEqual({ status: "error", code: "UNSAFE_ADDRESS" });
    expect(
      (await operator.post("/api/integrations", { adapter: "jellyfin", name: "No URL" })).status,
    ).toBe(400);
    expect(
      (
        await operator.post("/api/integrations", {
          adapter: "jellyfin",
          name: "Creds",
          baseUrl: "http://user:pass@127.0.0.1",
        })
      ).status,
    ).toBe(400);
  });

  it("streams minimized app data on integration topics with per-audience access", async () => {
    const { operator, viewer } = await withRoles();
    const baseUrl = await jellyfin();
    const integration = await createIntegration(operator, {
      adapter: "jellyfin",
      name: "Media",
      baseUrl,
      secret: "jf-secret",
    });
    const topic = `data.integration.${integration.id}.sessions`;
    const response = await operator.get(`/api/events?topics=${topic},data.storage`);
    expect(response.status).toBe(200);
    const { events, reader } = await readEvents(response, 3);
    await reader.cancel();
    const byTopic = new Map(
      events
        .filter((e) => e.event === "data")
        .map((e) => [(e.data as TopicMessage).topic, e.data as TopicMessage]),
    );
    const sessions = byTopic.get(topic);
    expect(sessions).toMatchObject({
      status: "ok",
      data: {
        active: 2,
        streaming: 1,
        sessions: [{ user: "ayse", title: "Pilot", series: "Show", progress: 0.25, paused: false }],
      },
    });
    // Only displayed fields leave the API (no client IP addresses).
    expect(JSON.stringify(sessions)).not.toContain("192.168.1.50");
    expect(byTopic.get("data.storage")).toMatchObject({ status: "ok" });

    // A viewer cannot read managers-only data; other topics keep working.
    const viewerResponse = await viewer.get(`/api/events?topics=${topic},data.system`);
    const viewerEvents = await readEvents(viewerResponse, 3);
    await viewerEvents.reader.cancel();
    const viewerTopics = new Map(
      viewerEvents.events
        .filter((e) => e.event === "data")
        .map((e) => [(e.data as TopicMessage).topic, e.data as TopicMessage]),
    );
    expect(viewerTopics.get(topic)).toMatchObject({ status: "error", code: "FORBIDDEN" });
    expect(viewerTopics.get("data.system")).toMatchObject({ status: "ok" });

    expect((await operator.get("/api/events?topics=data.secrets")).status).toBe(400);
  });

  it("limits Home Assistant data and controls to entities an administrator allowed", async () => {
    const { operator } = await withRoles();
    const calls: Array<{ url: string; body: string }> = [];
    const baseUrl = await fakeApp((req, res, body) => {
      if (req.headers.authorization !== "Bearer ha-token") return send(res, 401, {});
      if (req.method === "POST") {
        calls.push({ url: req.url ?? "", body });
        return send(res, 200, []);
      }
      if (req.url === "/api/states")
        return send(res, 200, [
          {
            entity_id: "switch.kettle",
            state: "off",
            attributes: { friendly_name: "Kettle" },
            last_changed: "2026-10-10T10:00:00Z",
          },
          {
            entity_id: "sensor.living_temp",
            state: "21.5",
            attributes: { unit_of_measurement: "°C", device_class: "temperature" },
          },
          { entity_id: "person.ayse", state: "home", attributes: {} },
          {
            entity_id: "automation.lights",
            state: "on",
            attributes: { friendly_name: "Lights", last_triggered: "2026-10-10T09:00:00Z" },
          },
        ]);
      return send(res, 404, {});
    });
    const integration = await createIntegration(operator, {
      adapter: "homeassistant",
      name: "Home",
      baseUrl,
      secret: "ha-token",
      options: { entities: ["sensor.living_temp"], controlEntities: ["switch.kettle"] },
    });
    const response = await operator.get(
      `/api/events?topics=data.integration.${integration.id}.states`,
    );
    const { events, reader } = await readEvents(response, 2);
    await reader.cancel();
    const states = events[1]!.data as TopicMessage & {
      data: { entities: Array<{ entityId: string }> };
    };
    // person.ayse (presence) was not exposed, so it never leaves the API.
    expect(states.data.entities.map((e) => e.entityId).sort()).toEqual([
      "sensor.living_temp",
      "switch.kettle",
    ]);

    const control = (entityId: string) =>
      operator.post(`/api/integrations/${integration.id}/actions`, { entityId, service: "toggle" });
    expect((await control("switch.kettle")).status).toBe(200);
    expect(calls).toEqual([
      { url: "/api/services/switch/toggle", body: JSON.stringify({ entity_id: "switch.kettle" }) },
    ]);
    expect((await control("switch.garage")).status).toBe(403);
    // Only switchable domains can be configured as controls.
    expect(
      (
        await operator.patch(`/api/integrations/${integration.id}`, {
          options: { controlEntities: ["lock.front_door"] },
        })
      ).status,
    ).toBe(400);
  });

  it("serves PostgreSQL statistics through the agent without credentials", async () => {
    const { operator } = await withRoles();
    const integration = await createIntegration(operator, {
      adapter: "postgresql",
      name: "Cloud DB",
      options: { container: "nextcloud-db", user: "postgres", database: "postgres" },
    });
    expect(await json(await operator.post(`/api/integrations/${integration.id}/test`, {}))).toEqual(
      { status: "ok" },
    );
    const response = await operator.get(
      `/api/events?topics=data.integration.${integration.id}.stats`,
    );
    const { events, reader } = await readEvents(response, 2);
    await reader.cancel();
    expect(events[1]!.data).toMatchObject({
      status: "ok",
      data: {
        container: { state: "running", health: "healthy" },
        stats: { connections: 7, maxConnections: 100 },
      },
    });
  });
});

describe("system widget topics", () => {
  it("summarizes processes, services and alerts per permission", async () => {
    const { ctx, admin, viewer } = await withRoles();
    ctx.agent.handlers.set("services.list", () => ({
      source: "host",
      units: [
        {
          name: "backup.service",
          description: "Backup",
          load: "loaded",
          active: "failed",
          sub: "failed",
          unitFileState: "enabled",
          protected: false,
        },
        {
          name: "ssh.service",
          description: "SSH",
          load: "loaded",
          active: "active",
          sub: "running",
          unitFileState: "enabled",
          protected: true,
        },
      ],
    }));
    const read = async (client: TestClient, topics: string, count: number) => {
      const { events, reader } = await readEvents(
        await client.get(`/api/events?topics=${topics}`),
        count,
      );
      await reader.cancel();
      return new Map(
        events
          .filter((e) => e.event === "data")
          .map((e) => [(e.data as TopicMessage).topic, e.data as TopicMessage & { data: unknown }]),
      );
    };
    const adminTopics = await read(
      admin,
      "data.services,data.alerts,data.sockets,data.apt,data.timers",
      6,
    );
    expect(adminTopics.get("data.services")?.data).toMatchObject({
      total: 2,
      active: 1,
      failed: [{ name: "backup.service" }],
    });
    const adminAlerts = adminTopics.get("data.alerts")?.data as {
      source: string;
      alerts: Array<{ kind: string; subject: string }>;
    };
    // The test agent serves services and Docker from simulators, so alerts say so.
    expect(adminAlerts.source).toBe("simulated");
    expect(adminAlerts.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "service-failed", subject: "backup.service" }),
        expect.objectContaining({ kind: "container-unhealthy", subject: "pihole" }),
        expect.objectContaining({ kind: "security-updates", subject: "2" }),
      ]),
    );
    expect(adminTopics.get("data.sockets")?.data).toMatchObject({
      connections: { established: 3 },
    });
    // Viewers (no logs/services management) still see service health, but nothing they lack permission for.
    const viewerTopics = await read(viewer, "data.alerts,data.processes", 3);
    const processes = viewerTopics.get("data.processes")?.data as { byCpu: unknown[] };
    expect(Array.isArray(processes.byCpu)).toBe(true);
    expect(JSON.stringify(processes)).not.toContain("command");
  });

  it("stores the widget layout as a validated preference document", async () => {
    const { admin } = await withRoles();
    const layout = {
      version: 1,
      sidebar: { open: true },
      instances: [
        {
          id: "w1",
          widgetId: "system.cpu",
          widgetVersion: 1,
          placement: "desktop",
          size: "custom",
          custom: { w: 3, h: 2 },
          position: { col: 8, row: 0 },
          desktopId: "d1",
          order: 0,
          opacity: 0.8,
          locked: false,
          config: { chart: true },
        },
      ],
    };
    expect((await admin.request("PUT", "/api/preferences/widgets", { body: layout })).status).toBe(
      204,
    );
    const stored = await json<{ preferences: { widgets: typeof layout } }>(
      await admin.get("/api/preferences"),
    );
    expect(stored.preferences.widgets).toEqual(layout);
    const invalid = { ...layout, instances: [{ ...layout.instances[0], opacity: 5 }] };
    const response = await admin.request("PUT", "/api/preferences/widgets", { body: invalid });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("VALIDATION_FAILED");
  });
});
