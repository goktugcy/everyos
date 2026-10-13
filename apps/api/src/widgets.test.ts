import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { silentLogger } from "@everyos/logger";
import type {
  ApiErrorBody,
  IntegrationView,
  Permission,
  TopicMessage,
  HomeAssistantStates,
} from "@everyos/shared";
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
      if (req.url === "/api/services")
        return send(res, 200, [
          { domain: "switch", services: { toggle: {}, turn_on: {}, turn_off: {} } },
        ]);
      if (req.url === "/api/states/switch.kettle")
        return send(res, 200, {
          entity_id: "switch.kettle",
          state: "off",
          attributes: { friendly_name: "Kettle" },
        });
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
    // Read-only domains cannot be configured as controls.
    expect(
      (
        await operator.patch(`/api/integrations/${integration.id}`, {
          options: { controlEntities: ["sensor.living_temp"] },
        })
      ).status,
    ).toBe(400);
  });

  it("exposes explicit all-entity scopes and validates device actions, audience and ranges", async () => {
    const { operator, viewer } = await withRoles();
    const calls: Array<{ url: string; body: unknown }> = [];
    const states = [
      { entity_id: "switch.kettle", state: "off", attributes: { friendly_name: "Kettle" } },
      {
        entity_id: "sensor.temp",
        state: "21",
        attributes: { unit_of_measurement: "°C", access_token: "never-expose" },
      },
      { entity_id: "person.ayse", state: "home", attributes: { latitude: 41, longitude: 29 } },
      { entity_id: "cover.blind", state: "closed", attributes: { supported_features: 3 } },
      {
        entity_id: "climate.room",
        state: "heat",
        attributes: {
          supported_features: 1,
          min_temp: 16,
          max_temp: 30,
          temperature: 22,
          hvac_modes: ["heat", "off"],
        },
      },
      { entity_id: "lock.door", state: "locked", attributes: {} },
      { entity_id: "light.offline", state: "unavailable", attributes: {} },
    ];
    const services = [
      { domain: "switch", services: { toggle: {}, turn_on: {}, turn_off: {} } },
      { domain: "cover", services: { open_cover: {}, close_cover: {}, stop_cover: {} } },
      { domain: "climate", services: { set_temperature: {}, set_hvac_mode: {} } },
      { domain: "lock", services: { lock: {}, unlock: {} } },
      { domain: "light", services: { turn_on: {}, toggle: {} } },
    ];
    let pauseStates = false;
    let pauseTarget = false;
    const releases: Array<() => void> = [];
    const baseUrl = await fakeApp((req, res, body) => {
      if (req.headers.authorization !== "Bearer ha-all-token") return send(res, 401, {});
      if (req.method === "POST") {
        calls.push({ url: req.url ?? "", body: JSON.parse(body) });
        return send(res, 200, []);
      }
      if (req.url === "/api/states") {
        if (pauseStates) {
          releases.push(() => send(res, 200, states));
          return;
        }
        return send(res, 200, states);
      }
      if (req.url === "/api/services") return send(res, 200, services);
      const entity = states.find((state) => req.url === `/api/states/${state.entity_id}`);
      if (entity && pauseTarget) {
        releases.push(() => send(res, 200, entity));
        return;
      }
      return entity ? send(res, 200, entity) : send(res, 404, {});
    });
    const integration = await createIntegration(operator, {
      adapter: "homeassistant",
      name: "All devices",
      baseUrl,
      secret: "ha-all-token",
      options: { entityScope: "all", controlScope: "all" },
    });
    expect((await viewer.get(`/api/integrations/${integration.id}/states`)).status).toBe(403);
    expect((await viewer.get(`/api/integrations/${integration.id}/brand/hue`)).status).toBe(403);
    expect((await operator.get(`/api/integrations/${integration.id}/brand/unknown`)).status).toBe(
      400,
    );
    expect(
      (
        await viewer.post(`/api/integrations/${integration.id}/actions`, {
          entityId: "switch.kettle",
          service: "toggle",
        })
      ).status,
    ).toBe(403);
    const all = await json<{ data: { entities: Array<{ entityId: string; actions: string[] }> } }>(
      await operator.get(`/api/integrations/${integration.id}/states`),
    );
    expect(all.data.entities).toHaveLength(7);
    expect(all.data.entities.find((entity) => entity.entityId === "cover.blind")?.actions).toEqual([
      "open_cover",
      "close_cover",
    ]);
    expect(JSON.stringify(all)).not.toMatch(/ha-all-token|never-expose|latitude|longitude/);
    const action = (body: object) =>
      operator.post(`/api/integrations/${integration.id}/actions`, body);
    expect((await action({ entityId: "sensor.temp", service: "turn_on" })).status).toBe(403);
    expect((await action({ entityId: "cover.blind", service: "stop_cover" })).status).toBe(400);
    expect(
      (await action({ entityId: "climate.room", service: "set_temperature", temperature: 99 }))
        .status,
    ).toBe(400);
    expect(
      (await action({ entityId: "climate.room", service: "set_hvac_mode", hvacMode: "invalid" }))
        .status,
    ).toBe(400);
    expect((await action({ entityId: "switch.kettle", service: "restart" })).status).toBe(400);
    expect(
      (
        await action({
          entityId: "switch.kettle",
          service: "turn_on",
          extra: { entity_id: "lock.door" },
        })
      ).status,
    ).toBe(400);
    expect((await action({ entityId: "lock.door", service: "unlock" })).status).toBe(400);
    expect((await action({ entityId: "light.offline", service: "toggle" })).status).toBe(409);
    expect(calls).toEqual([]);
    expect((await action({ entityId: "cover.blind", service: "close_cover" })).status).toBe(200);
    expect(
      (await action({ entityId: "climate.room", service: "set_temperature", temperature: 23 }))
        .status,
    ).toBe(200);
    expect((await action({ entityId: "lock.door", service: "unlock", confirm: true })).status).toBe(
      200,
    );
    expect(calls).toEqual([
      { url: "/api/services/cover/close_cover", body: { entity_id: "cover.blind" } },
      {
        url: "/api/services/climate/set_temperature",
        body: { entity_id: "climate.room", temperature: 23 },
      },
      { url: "/api/services/lock/unlock", body: { entity_id: "lock.door" } },
    ]);
    expect(
      (await operator.patch(`/api/integrations/${integration.id}`, { audience: "everyone" }))
        .status,
    ).toBe(200);
    expect((await viewer.get(`/api/integrations/${integration.id}/states`)).status).toBe(200);
    const shared = await json<{ data: { entities: unknown[] } }>(
      await viewer.get(`/api/integrations/${integration.id}/states`),
    );
    expect(shared.data.entities).toHaveLength(7);
    pauseStates = true;
    const pending = viewer.get(`/api/integrations/${integration.id}/states`);
    await expect.poll(() => releases.length > 0).toBe(true);
    await operator.patch(`/api/integrations/${integration.id}`, { audience: "managers" });
    releases.pop()!();
    expect((await pending).status).toBe(403);
    pauseStates = false;
    await operator.patch(`/api/integrations/${integration.id}`, { audience: "everyone" });
    expect(
      (
        await operator.patch(`/api/integrations/${integration.id}`, {
          options: { entities: ["sensor.temp"], controlEntities: ["switch.kettle"] },
        })
      ).status,
    ).toBe(200);
    const restricted = await json<{ data: { entities: Array<{ entityId: string }> } }>(
      await viewer.get(`/api/integrations/${integration.id}/states`),
    );
    expect(restricted.data.entities.map((entity) => entity.entityId).sort()).toEqual([
      "sensor.temp",
      "switch.kettle",
    ]);
    expect((await action({ entityId: "cover.blind", service: "close_cover" })).status).toBe(403);
    pauseTarget = true;
    const pendingAction = action({ entityId: "switch.kettle", service: "toggle" });
    await expect.poll(() => releases.length > 0).toBe(true);
    await operator.patch(`/api/integrations/${integration.id}`, {
      options: { entities: ["sensor.temp"], controlEntities: [] },
    });
    releases.pop()!();
    expect((await pendingAction).status).toBe(409);
    expect(calls).toHaveLength(3);
    pauseTarget = false;
  });

  it("discovers extended device controls and rejects unsupported, stale and unauthorized settings", async () => {
    const { operator, viewer } = await withRoles();
    const states = [
      {
        entity_id: "light.color",
        state: "on",
        attributes: {
          supported_color_modes: ["rgb", "color_temp"],
          supported_features: 4,
          brightness: 128,
          rgb_color: [12, 34, 56],
          min_color_temp_kelvin: 2000,
          max_color_temp_kelvin: 6500,
          effect_list: ["rainbow"],
          access_token: "never-expose",
        },
      },
      { entity_id: "light.basic", state: "on", attributes: { supported_color_modes: ["onoff"] } },
      {
        entity_id: "fan.air",
        state: "on",
        attributes: {
          supported_features: 63,
          percentage: 50,
          preset_modes: ["auto", "sleep"],
          oscillating: false,
        },
      },
      {
        entity_id: "cover.blind",
        state: "open",
        attributes: { supported_features: 255, current_position: 50 },
      },
      {
        entity_id: "climate.room",
        state: "heat_cool",
        attributes: {
          supported_features: 2,
          min_temp: 16,
          max_temp: 30,
          target_temp_low: 20,
          target_temp_high: 24,
        },
      },
      {
        entity_id: "media_player.tv",
        state: "playing",
        attributes: {
          supported_features: 4 | 8 | 2048,
          source_list: ["HDMI 1", "HDMI 2"],
          volume_level: 0.5,
        },
      },
      {
        entity_id: "valve.water",
        state: "open",
        attributes: { supported_features: 15, current_position: 50 },
      },
      {
        entity_id: "water_heater.water",
        state: "on",
        attributes: {
          supported_features: 15,
          min_temp: 30,
          max_temp: 65,
          operation_list: ["eco"],
          away_mode: "off",
        },
      },
      {
        entity_id: "vacuum.robot",
        state: "docked",
        attributes: { supported_features: 8192 | 32, fan_speed_list: ["quiet", "turbo"] },
      },
    ];
    const services = [
      { domain: "light", services: { turn_on: {}, turn_off: {}, toggle: {} } },
      {
        domain: "fan",
        services: {
          set_percentage: {},
          set_preset_mode: {},
          oscillate: {},
          set_direction: {},
          turn_on: {},
          turn_off: {},
          toggle: {},
        },
      },
      {
        domain: "cover",
        services: { set_cover_position: {}, set_cover_tilt_position: {}, open_cover: {} },
      },
      { domain: "climate", services: { set_temperature: {} } },
      { domain: "media_player", services: { volume_set: {}, volume_mute: {}, select_source: {} } },
      {
        domain: "valve",
        services: { set_valve_position: {}, open_valve: {}, close_valve: {}, stop_valve: {} },
      },
      {
        domain: "water_heater",
        services: { set_temperature: {}, set_operation_mode: {}, set_away_mode: {} },
      },
      { domain: "vacuum", services: { start: {}, set_fan_speed: {} } },
    ];
    const calls: Array<{ path: string; body: unknown }> = [];
    const baseUrl = await fakeApp((req, res, body) => {
      if (req.headers.authorization !== "Bearer extended-ha-token") return send(res, 401, {});
      if (req.method === "POST") {
        calls.push({ path: req.url ?? "", body: JSON.parse(body) });
        return send(res, 200, []);
      }
      if (req.url === "/api/states") return send(res, 200, states);
      if (req.url === "/api/services") return send(res, 200, services);
      const entity = states.find((e) => req.url === `/api/states/${e.entity_id}`);
      return entity ? send(res, 200, entity) : send(res, 404, {});
    });
    const integration = await createIntegration(operator, {
      adapter: "homeassistant",
      name: "Extended controls",
      baseUrl,
      secret: "extended-ha-token",
      audience: "everyone",
      options: { entityScope: "all", controlScope: "all" },
    });
    const read = async () =>
      json<{ data: HomeAssistantStates }>(
        await operator.get(`/api/integrations/${integration.id}/states`),
      );
    const action = (entityId: string, control: string, value: unknown, extra: object = {}) =>
      operator.post(`/api/integrations/${integration.id}/actions`, {
        entityId,
        service: "configure",
        control,
        value,
        ...extra,
      });
    const data = (await read()).data;
    const controls = (id: string) => data.entities.find((e) => e.entityId === id)!.controls;
    expect(controls("light.basic")).toEqual([]);
    expect(controls("light.color").map((c) => c.id)).toEqual([
      "brightness",
      "color",
      "colorTemperature",
      "effect",
    ]);
    expect(controls("fan.air").map((c) => c.id)).toContain("oscillation");
    expect(controls("climate.room")).toEqual([
      expect.objectContaining({ kind: "temperatureRange", value: [20, 24] }),
    ]);
    expect(data.controllable).toContain("climate.room");
    expect(controls("valve.water").map((c) => c.id)).toContain("valvePosition");
    expect(controls("water_heater.water").map((c) => c.id)).toContain("waterHeaterMode");
    expect(controls("vacuum.robot").map((c) => c.id)).toContain("vacuumFan");
    expect(JSON.stringify(data)).not.toMatch(/extended-ha-token|never-expose/);
    expect((await action("light.basic", "brightness", 50)).status).toBe(400);
    expect((await action("light.color", "brightness", 101)).status).toBe(400);
    expect((await action("light.color", "brightness", "50")).status).toBe(400);
    expect((await action("light.color", "color", [256, 0, 0])).status).toBe(400);
    expect((await action("light.color", "colorTemperature", 1000)).status).toBe(400);
    expect((await action("light.color", "effect", "unsupported")).status).toBe(400);
    expect((await action("light.color", "source", "HDMI 1")).status).toBe(400);
    expect((await action("fan.air", "oscillation", "true")).status).toBe(400);
    expect((await action("climate.room", "temperatureRange", [25, 20])).status).toBe(400);
    expect((await action("cover.blind", "position", 25.5)).status).toBe(400);
    expect((await action("light.color", "brightness", 50, { entity_id: "lock.door" })).status).toBe(
      400,
    );
    expect(
      (
        await viewer.post(`/api/integrations/${integration.id}/actions`, {
          entityId: "light.color",
          service: "configure",
          control: "brightness",
          value: 50,
        })
      ).status,
    ).toBe(403);
    expect(calls).toEqual([]);
    for (const [entityId, control, value] of [
      ["light.color", "brightness", 75],
      ["light.color", "color", [255, 64, 0]],
      ["light.color", "colorTemperature", 3000],
      ["fan.air", "oscillation", true],
      ["fan.air", "fanPreset", "sleep"],
      ["cover.blind", "position", 40],
      ["climate.room", "temperatureRange", [20, 24]],
      ["media_player.tv", "volume", 0.3],
      ["media_player.tv", "source", "HDMI 2"],
    ] as const)
      expect((await action(entityId, control, value)).status).toBe(200);
    expect(calls).toEqual([
      {
        path: "/api/services/light/turn_on",
        body: { entity_id: "light.color", brightness_pct: 75 },
      },
      {
        path: "/api/services/light/turn_on",
        body: { entity_id: "light.color", rgb_color: [255, 64, 0] },
      },
      {
        path: "/api/services/light/turn_on",
        body: { entity_id: "light.color", color_temp_kelvin: 3000 },
      },
      { path: "/api/services/fan/oscillate", body: { entity_id: "fan.air", oscillating: true } },
      {
        path: "/api/services/fan/set_preset_mode",
        body: { entity_id: "fan.air", preset_mode: "sleep" },
      },
      {
        path: "/api/services/cover/set_cover_position",
        body: { entity_id: "cover.blind", position: 40 },
      },
      {
        path: "/api/services/climate/set_temperature",
        body: { entity_id: "climate.room", target_temp_low: 20, target_temp_high: 24 },
      },
      {
        path: "/api/services/media_player/volume_set",
        body: { entity_id: "media_player.tv", volume_level: 0.3 },
      },
      {
        path: "/api/services/media_player/select_source",
        body: { entity_id: "media_player.tv", source: "HDMI 2" },
      },
    ]);
    states[0]!.attributes.supported_color_modes = ["onoff"];
    expect((await action("light.color", "color", [255, 64, 0])).status).toBe(400);
    await operator.patch(`/api/integrations/${integration.id}`, {
      options: { entityScope: "all", controlScope: "selected", controlEntities: [] },
    });
    expect((await action("fan.air", "percentage", 50)).status).toBe(403);
    expect((await read()).data.entities.every((e) => !e.actions.length && !e.controls.length)).toBe(
      true,
    );
    expect(calls).toHaveLength(9);
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
