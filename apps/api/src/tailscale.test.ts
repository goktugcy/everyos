import type {
  NotificationList,
  TailscaleDetails,
  TailscaleOverview,
  TailscaleStatus,
} from "@everyos/shared";
import { describe, expect, it } from "vitest";
import { analyzeTailscale, serveTarget } from "./modules/system/tailscale.ts";
import { json, withRoles, type TestContext } from "./test-support.ts";

const DAY = 24 * 60 * 60_000;
const NOW = 1_760_000_000_000;

const status = (overrides: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
  status: { available: true },
  backendState: "Running",
  version: "1.104.0",
  hostName: "pi",
  dnsName: "pi.tail1234.ts.net",
  tailnet: "owner@example.com",
  ips: ["100.102.81.59"],
  online: true,
  exitNode: { active: false, name: null, online: null },
  peers: { total: 2, online: 1 },
  health: [],
  ...overrides,
});

const details = (
  handlers: TailscaleDetails["serve"]["handlers"] = [],
  keyExpiry: number | null = NOW + 90 * DAY,
): TailscaleDetails => ({
  status: { available: true },
  self: {
    os: "linux",
    relay: "fra",
    keyExpiry,
    keyExpired: false,
    exitNodeOption: false,
    routes: [],
    tags: [],
    magicDNS: true,
    magicDNSSuffix: "tail1234.ts.net",
  },
  prefs: {
    available: true,
    ssh: false,
    shieldsUp: false,
    acceptRoutes: false,
    acceptDNS: true,
    advertisedRoutes: [],
    advertisesExitNode: false,
    exitNodeAllowLAN: false,
  },
  serve: { available: true, handlers },
});

const proxy = (target: string, funnel = false, port = 443) => ({
  host: "pi.tail1234.ts.net",
  port,
  path: "/",
  kind: "proxy" as const,
  target,
  funnel,
});

const analyze = (
  s: TailscaleStatus,
  d: TailscaleDetails,
  publicOrigins: string[] = [],
  trusted = false,
) =>
  analyzeTailscale({
    status: s,
    details: d,
    server: { port: 7470, publicOrigins },
    isTrustedProxy: () => trusted,
    now: NOW,
  });

function useTailscale(ctx: TestContext, s: TailscaleStatus, d: TailscaleDetails) {
  ctx.agent.handlers.set("tailscale.status", () => s);
  ctx.agent.handlers.set("tailscale.details", () => d);
  ctx.agent.handlers.set("tailscale.peers", () => ({
    status: { available: true },
    peers: [
      {
        hostName: "laptop",
        dnsName: "laptop.tail1234.ts.net",
        os: "macOS",
        ips: ["100.64.0.2"],
        online: true,
        active: true,
        lastSeen: null,
        exitNode: false,
        exitNodeOption: false,
        connection: "direct",
        relay: "fra",
        rxBytes: 1,
        txBytes: 2,
        keyExpiry: null,
        tags: [],
      },
    ],
  }));
}

describe("tailscale analysis", () => {
  it("recognizes Serve targets that point at EveryOS", () => {
    expect(serveTarget("7470")).toEqual({ host: "127.0.0.1", port: 7470 });
    expect(serveTarget("localhost:7470")).toEqual({ host: "localhost", port: 7470 });
    expect(serveTarget("http://127.0.0.1:7470")).toEqual({ host: "127.0.0.1", port: 7470 });
    expect(serveTarget("https+insecure://[::1]:7470")).toEqual({ host: "::1", port: 7470 });
    expect(serveTarget("http://example.com")).toEqual({ host: "example.com", port: 80 });
  });

  it("suggests the recommended Serve setup when EveryOS is not published", () => {
    const result = analyze(status(), details());
    expect(result.warnings).toEqual([]);
    expect(result.remoteAccess).toEqual({
      port: 7470,
      urls: [],
      proxyTrusted: false,
      managed: null,
      suggestion: {
        url: "https://pi.tail1234.ts.net",
        command: "tailscale serve --bg --https=443 http://127.0.0.1:7470",
      },
    });
  });

  it("checks a published EveryOS against its configuration", () => {
    const configured = analyze(
      status(),
      details([proxy("http://127.0.0.1:7470"), proxy("http://127.0.0.1:3000", false, 8443)]),
      ["https://pi.tail1234.ts.net"],
      true,
    );
    expect(configured.remoteAccess.urls).toEqual([
      { url: "https://pi.tail1234.ts.net", funnel: false, originAllowed: true },
    ]);
    expect(configured.warnings).toEqual([]);
    expect(configured.remoteAccess.suggestion).toBeNull();

    const misconfigured = analyze(status(), details([proxy("7470", false, 8443)]));
    expect(misconfigured.warnings.map((w) => w.kind)).toEqual([
      "origin-missing",
      "proxy-untrusted",
    ]);
    expect(misconfigured.warnings[0]!.params).toEqual({ url: "https://pi.tail1234.ts.net:8443" });
  });

  it("warns loudly about Funnel, expiring keys, login and exit nodes", () => {
    const result = analyze(
      status({
        backendState: "NeedsLogin",
        exitNode: { active: true, name: "vps", online: false },
        health: ["not connected to home DERP region"],
      }),
      details([proxy("http://127.0.0.1:7470", true)], NOW + 3 * DAY + 60_000),
      ["https://pi.tail1234.ts.net"],
      true,
    );
    expect(result.warnings.map((w) => [w.kind, w.severity])).toEqual([
      ["needs-login", "warning"],
      ["key-expiring", "warning"],
      ["exit-node-offline", "warning"],
      ["funnel-public", "critical"],
      ["health", "info"],
    ]);
    expect(result.warnings[1]!.params).toMatchObject({ days: 3 });
    expect(result.remoteAccess.urls[0]).toMatchObject({ funnel: true });
  });
});

describe("tailscale routes", () => {
  it("gives everyone with system access the overview and only administrators the devices", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    useTailscale(ctx, status(), details([proxy("http://127.0.0.1:7470", true)]));
    const forViewer = await json<TailscaleOverview>(
      await viewer.get("/api/system/tailscale/overview"),
    );
    expect(forViewer).toMatchObject({ canSeePeers: false, status: { hostName: "pi" } });
    expect(forViewer.warnings.map((w) => w.kind)).toContain("funnel-public");
    expect((await operator.get("/api/system/tailscale/peers")).status).toBe(403);
    expect((await viewer.get("/api/system/tailscale/peers")).status).toBe(403);
    const forAdmin = await json<TailscaleOverview>(
      await admin.get("/api/system/tailscale/overview"),
    );
    expect(forAdmin.canSeePeers).toBe(true);
    const peers = await json<{ peers: unknown[] }>(await admin.get("/api/system/tailscale/peers"));
    expect(peers.peers).toHaveLength(1);
  });

  it("raises and resolves key-expiry and Funnel notifications", async () => {
    const { ctx, admin, viewer } = await withRoles();
    useTailscale(
      ctx,
      status(),
      details([proxy("http://127.0.0.1:7470", true)], ctx.clock.now + 5 * DAY + 60_000),
    );
    await ctx.services.hostMonitor.check();
    const forAdmin = await json<NotificationList>(await admin.get("/api/notifications"));
    expect(
      forAdmin.notifications
        .filter((n) => n.kind.startsWith("tailscale-"))
        .map((n) => [n.kind, n.params]),
    ).toEqual(
      expect.arrayContaining([
        ["tailscale-key-expiry", { days: 5 }],
        ["tailscale-funnel", { url: "https://pi.tail1234.ts.net" }],
      ]),
    );
    // Funnel warnings are for administrators; viewers see the key expiry.
    const forViewer = await json<NotificationList>(await viewer.get("/api/notifications"));
    expect(forViewer.notifications.map((n) => n.kind)).toContain("tailscale-key-expiry");
    expect(forViewer.notifications.map((n) => n.kind)).not.toContain("tailscale-funnel");

    useTailscale(ctx, status(), details([proxy("http://127.0.0.1:7470")]));
    await ctx.services.hostMonitor.check();
    const after = await json<NotificationList>(await admin.get("/api/notifications"));
    const open = after.notifications.filter(
      (n) => n.kind.startsWith("tailscale-") && n.resolvedAt === null,
    );
    expect(open).toEqual([]);
  });
});
