import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { AgentClientError } from "@everyos/agent-protocol";
import { silentLogger } from "@everyos/logger";
import { SecretBox } from "@everyos/security";
import type { ApiErrorBody, BootstrapResponse, HttpsView, SessionInfo } from "@everyos/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostNamesFromNetwork,
  HttpsService,
  type HostNames,
} from "./modules/security/https-service.ts";
import { createLanListener } from "./modules/security/lan-listener.ts";
import {
  completeSetup,
  createTestContext,
  json,
  TestClient,
  type TestContext,
} from "./test-support.ts";

const errorOf = async (response: Response) => (await json<ApiErrorBody>(response)).error;
const port = () => 40_000 + Math.floor(Math.random() * 20_000);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup() {
  const ctx = await createTestContext();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  return { ctx, admin };
}

/** A GET over HTTPS that trusts only `ca`. */
function get(url: string, ca: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; authorized: boolean }>((resolve, reject) => {
    const req = request(url, { ca, headers, agent: false }, (response) => {
      const authorized = (response.socket as { authorized?: boolean }).authorized === true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          authorized,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function attachListener(ctx: TestContext) {
  const lan = createLanListener({
    fetch: ctx.app.fetch,
    hostname: "127.0.0.1",
    attach: () => () => undefined,
    logger: silentLogger,
  });
  ctx.services.https.attach(lan);
  closers.push(() => lan.close());
}

describe("local-network HTTPS", () => {
  it("serves EveryOS over HTTPS with its own certificate authority, toggled live", async () => {
    const { ctx, admin } = await setup();
    attachListener(ctx);
    const first = port();
    const sameAsHttp = await admin.request("PUT", "/api/https/lan", {
      body: { enabled: true, port: ctx.config.server.port },
    });
    expect((await errorOf(sameAsHttp)).details).toEqual({ reason: "same-port" });

    const view = await json<HttpsView>(
      await admin.request("PUT", "/api/https/lan", { body: { enabled: true, port: first } }),
    );
    expect(view.lan).toMatchObject({ enabled: true, port: first, listening: true, error: null });
    expect(view.lan.certificate!.names).toEqual(expect.arrayContaining(["localhost", "127.0.0.1"]));
    const ca = await (await admin.get("/api/https/authority.crt")).text();
    expect(new X509Certificate(ca).ca).toBe(true);
    expect(view.lan.authority!.fingerprint).toBe(new X509Certificate(ca).fingerprint256);

    const health = await get(`https://127.0.0.1:${first}/api/bootstrap`, ca);
    expect(health).toMatchObject({ status: 200, authorized: true });
    expect((JSON.parse(health.body) as BootstrapResponse).transport.secure).toBe(true);

    // The authority's key never leaves the database in the clear.
    const stored = ctx.db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = 'security.https.authority'",
    )!.value;
    expect(stored).not.toContain("PRIVATE KEY");

    // Moving the port restarts the listener; turning it off stops it.
    const second = port();
    await admin.request("PUT", "/api/https/lan", { body: { enabled: true, port: second } });
    expect((await get(`https://127.0.0.1:${second}/api/health`, ca)).status).toBe(200);
    await expect(get(`https://127.0.0.1:${first}/api/health`, ca)).rejects.toThrow();
    const off = await json<HttpsView>(
      await admin.request("PUT", "/api/https/lan", { body: { enabled: false, port: second } }),
    );
    expect(off.lan).toMatchObject({ enabled: false, listening: false });
    await expect(get(`https://127.0.0.1:${second}/api/health`, ca)).rejects.toThrow();
  });

  it("reports a taken port instead of failing", async () => {
    const { ctx, admin } = await setup();
    attachListener(ctx);
    const taken = port();
    const { createLocalCa, issueServerCertificate } = await import("./modules/security/x509.ts");
    const ca = createLocalCa({ commonName: "other", now: Date.now() });
    const leaf = issueServerCertificate({
      ca,
      commonName: "localhost",
      dnsNames: ["localhost"],
      ipAddresses: [],
      now: Date.now(),
    });
    const other = createLanListener({
      fetch: ctx.app.fetch,
      hostname: "127.0.0.1",
      attach: () => () => undefined,
      logger: silentLogger,
    });
    closers.push(() => other.close());
    expect(await other.apply({ port: taken, cert: leaf.certPem, key: leaf.keyPem })).toBeNull();
    const view = await json<HttpsView>(
      await admin.request("PUT", "/api/https/lan", { body: { enabled: true, port: taken } }),
    );
    expect(view.lan).toMatchObject({ enabled: true, listening: false, error: "port-in-use" });
  });

  it("re-issues the certificate when the host's addresses change, keeping the authority", async () => {
    const ctx = await createTestContext();
    let names: HostNames = { dnsNames: ["pi", "pi.local"], ipAddresses: ["192.168.1.20"] };
    const https = new HttpsService({
      db: ctx.db,
      secrets: new SecretBox(Buffer.alloc(32, 1)),
      config: ctx.config,
      logger: silentLogger,
      now: () => Date.now(),
      names: () => Promise.resolve(names),
    });
    const applied: string[] = [];
    https.attach({
      apply: (next) => {
        if (next) applied.push(next.cert);
        return Promise.resolve(null);
      },
    });
    await https.setLan(true, 47443);
    await https.start();
    https.stop();
    expect(new Set(applied).size).toBe(1);
    const before = https.view().lan;
    expect(before.urls).toEqual([
      "https://pi:47443",
      "https://pi.local:47443",
      "https://192.168.1.20:47443",
    ]);
    names = { dnsNames: ["pi", "pi.local"], ipAddresses: ["192.168.1.21", "fd7a:115c:a1e0::5"] };
    await https.setLan(true, 47443);
    const after = https.view().lan;
    expect(new Set(applied).size).toBe(2);
    expect(after.certificate!.names).toEqual([
      "pi",
      "pi.local",
      "192.168.1.21",
      "fd7a:115c:a1e0::5",
    ]);
    expect(after.authority).toEqual(before.authority);
    expect(after.urls).toContain("https://[fd7a:115c:a1e0::5]:47443");
  });
});

describe("host addresses for the certificate", () => {
  it("come from the agent's interfaces, and an unknown answer keeps the certificate", async () => {
    const iface = (name: string, kind: string, up: boolean, addresses: string[]) => ({
      name,
      kind: kind as "ethernet",
      up,
      mac: null,
      mtu: null,
      speedMbps: null,
      addresses: addresses.map((address) => ({
        family: address.includes(":") ? ("ipv6" as const) : ("ipv4" as const),
        address,
        prefix: 24,
      })),
    });
    const names = hostNamesFromNetwork({
      source: "host",
      interfaces: [
        iface("eth0", "ethernet", true, ["192.168.1.20", "fe80::1"]),
        iface("docker0", "bridge", true, ["172.17.0.1"]),
        iface("tailscale0", "tailscale", true, ["100.64.0.5"]),
        iface("wlan0", "wireless", false, ["192.168.1.99"]),
      ],
      gateways: [],
      dns: [],
      internet: { state: "online", checkedAt: 1, latencyMs: 1 },
    });
    expect(names.ipAddresses).toEqual(["127.0.0.1", "::1", "192.168.1.20", "100.64.0.5"]);

    const ctx = await createTestContext();
    let answer: HostNames | null = { dnsNames: ["pi"], ipAddresses: ["192.168.1.20"] };
    const https = new HttpsService({
      db: ctx.db,
      secrets: new SecretBox(Buffer.alloc(32, 2)),
      config: ctx.config,
      logger: silentLogger,
      now: () => Date.now(),
      names: () => Promise.resolve(answer),
    });
    const certificates: string[] = [];
    https.attach({
      apply: (next) => {
        if (next) certificates.push(next.cert);
        return Promise.resolve(null);
      },
    });
    await https.setLan(true, 47444);
    answer = null;
    await https.setLan(true, 47444);
    expect(new Set(certificates).size).toBe(1);
    expect(https.view().lan.urls).toEqual(["https://pi:47444", "https://192.168.1.20:47444"]);
  });
});

describe("Tailscale Serve from EveryOS", () => {
  it("turns its handler on, then accepts the tailnet origin through the loopback proxy", async () => {
    const { ctx, admin } = await setup();
    const calls: unknown[] = [];
    ctx.agent.handlers.set("tailscale.serve", (params) => {
      calls.push(params);
      return {
        url: (params as { enabled: boolean }).enabled ? "https://pi.tail1234.ts.net" : null,
      };
    });
    // Before: the tailnet origin is foreign, forwarded headers from loopback are ignored.
    const proxied = (client: TestClient) =>
      client.request("PATCH", "/api/account", {
        body: { displayName: "Owner" },
        ip: "127.0.0.1",
        headers: {
          origin: "https://pi.tail1234.ts.net",
          host: "pi.tail1234.ts.net",
          "x-forwarded-for": "100.64.0.2",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "pi.tail1234.ts.net",
        },
      });
    expect((await errorOf(await proxied(admin))).code).toBe("CSRF_FAILED");

    const on = await json<HttpsView>(
      await admin.request("PUT", "/api/https/tailscale", { body: { enabled: true } }),
    );
    expect(calls).toEqual([{ enabled: true, port: ctx.config.server.port }]);
    expect(on.tailscale).toMatchObject({ url: "https://pi.tail1234.ts.net", enabledBy: "admin" });
    expect((await proxied(admin)).status).toBe(200);
    // The browser behind Serve is seen as itself, over HTTPS.
    const transport = await json<BootstrapResponse>(
      await admin.get("/api/bootstrap", {
        ip: "127.0.0.1",
        headers: { "x-forwarded-for": "100.64.0.2", "x-forwarded-proto": "https" },
      }),
    );
    expect(transport.transport).toMatchObject({ secure: true, loopback: false });

    await admin.request("PUT", "/api/https/tailscale", { body: { enabled: false } });
    expect((await errorOf(await proxied(admin))).code).toBe("CSRF_FAILED");
    expect(ctx.services.https.origins()).toEqual([]);
  });

  it("explains why Tailscale refused and needs an administrator", async () => {
    const { ctx, admin } = await setup();
    ctx.agent.handlers.set("tailscale.serve", () => {
      throw new AgentClientError(
        "AGENT_OPERATION_FAILED",
        "https-disabled: HTTPS certificates are off for the tailnet",
        "conflict",
      );
    });
    const refused = await admin.request("PUT", "/api/https/tailscale", { body: { enabled: true } });
    expect(await errorOf(refused)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "https-disabled" },
    });
    expect(ctx.services.https.settings().tailscale).toBeNull();
    const created = await admin.post("/api/users", {
      username: "viewer",
      displayName: "Viewer",
      password: "mavi-gokyuzu-ve-daglar-42",
      role: "viewer",
    });
    expect(created.status).toBe(201);
    const viewer = new TestClient(ctx, "192.0.2.9");
    const session = await viewer.login("viewer", "mavi-gokyuzu-ve-daglar-42");
    viewer.adopt((await json<{ session: SessionInfo }>(session)).session);
    expect(
      (await viewer.request("PUT", "/api/https/tailscale", { body: { enabled: true } })).status,
    ).toBe(403);
    expect((await viewer.get("/api/https")).status).toBe(403);
    // Every signed-in person may fetch the authority certificate for their devices.
    expect((await viewer.get("/api/https/authority.crt")).status).toBe(200);
    expect((await new TestClient(ctx).get("/api/https/authority.crt")).status).toBe(401);
  });
});
