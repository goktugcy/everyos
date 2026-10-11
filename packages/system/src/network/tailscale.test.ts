import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseServeConfig,
  parseTailscaleDetails,
  parseTailscalePeers,
} from "../linux/tailscale.ts";
import { getTailscaleDetails, getTailscalePeers } from "./tailscale-client.ts";

/* Shaped like tailscaled's LocalAPI responses (ipnstate.Status, ipn.Prefs, ipn.ServeConfig). */
const STATUS = {
  Version: "1.104.0",
  BackendState: "Running",
  TailscaleIPs: ["100.102.81.59", "fd7a:115c:a1e0::1"],
  Self: {
    HostName: "pi",
    DNSName: "pi.tail1234.ts.net.",
    OS: "linux",
    Online: true,
    Relay: "fra",
    KeyExpiry: "2026-10-20T10:00:00Z",
    ExitNodeOption: true,
    PrimaryRoutes: ["192.168.1.0/24", "0.0.0.0/0", "::/0"],
    Tags: ["tag:server"],
  },
  CurrentTailnet: {
    Name: "owner@example.com",
    MagicDNSSuffix: "tail1234.ts.net",
    MagicDNSEnabled: true,
  },
  Health: [],
  Peer: {
    "nodekey:a": {
      HostName: "laptop",
      DNSName: "laptop.tail1234.ts.net.",
      OS: "macOS",
      TailscaleIPs: ["100.64.0.2"],
      Online: true,
      Active: true,
      CurAddr: "192.168.1.30:41641",
      Relay: "fra",
      RxBytes: 1024,
      TxBytes: 2048,
      LastSeen: "0001-01-01T00:00:00Z",
      PublicKey: "nodekey:secret-should-not-leak",
    },
    "nodekey:b": {
      HostName: "phone",
      DNSName: "phone.tail1234.ts.net.",
      OS: "iOS",
      TailscaleIPs: ["100.64.0.3"],
      Online: true,
      Active: true,
      CurAddr: "",
      Relay: "ams",
      ExitNode: false,
      ExitNodeOption: false,
    },
    "nodekey:c": {
      HostName: "old-desktop",
      OS: "windows",
      TailscaleIPs: ["100.64.0.4"],
      Online: false,
      Active: false,
      LastSeen: "2026-09-01T12:00:00Z",
      KeyExpiry: "2027-01-01T00:00:00Z",
    },
  },
};

const PREFS = {
  RouteAll: false,
  CorpDNS: true,
  RunSSH: true,
  ShieldsUp: false,
  AdvertiseRoutes: ["192.168.1.0/24", "0.0.0.0/0", "::/0"],
  ExitNodeAllowLANAccess: false,
  Config: { PrivateNodeKey: "privkey:must-not-leak" },
};

const SERVE = {
  TCP: { "443": { HTTPS: true }, "2222": { TCPForward: "127.0.0.1:22" } },
  Web: {
    "pi.tail1234.ts.net:443": {
      Handlers: {
        "/": { Proxy: "http://127.0.0.1:7470" },
        "/docs": { Path: "/srv/docs" },
        "/hello": { Text: "hi" },
      },
    },
  },
  AllowFunnel: { "pi.tail1234.ts.net:443": true },
  Foreground: {
    session1: { Web: { "pi.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "3000" } } } } },
  },
};

const directories: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fakeLocalApi(routes: Record<string, { status?: number; body: unknown }>) {
  const dir = mkdtempSync(join(tmpdir(), "otuken-ts-"));
  directories.push(dir);
  const socket = join(dir, "tailscaled.sock");
  const server = createServer((request, response) => {
    // tailscaled requires this Host header; check that the client sends it.
    if (request.headers.host !== "local-tailscaled.sock") {
      response.writeHead(400).end();
      return;
    }
    const route = routes[request.url ?? ""];
    response.writeHead(route?.status ?? (route ? 200 : 404), {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(route?.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

describe("tailscale details", () => {
  it("keeps the node's details and never the keys", () => {
    const details = parseTailscaleDetails(STATUS, PREFS, SERVE);
    expect(details.self).toEqual({
      os: "linux",
      relay: "fra",
      keyExpiry: Date.parse("2026-10-20T10:00:00Z"),
      keyExpired: false,
      exitNodeOption: true,
      routes: ["192.168.1.0/24"],
      tags: ["tag:server"],
      magicDNS: true,
      magicDNSSuffix: "tail1234.ts.net",
    });
    expect(details.prefs).toEqual({
      available: true,
      ssh: true,
      shieldsUp: false,
      acceptRoutes: false,
      acceptDNS: true,
      advertisedRoutes: ["192.168.1.0/24"],
      advertisesExitNode: true,
      exitNodeAllowLAN: false,
    });
    expect(JSON.stringify(details)).not.toContain("privkey");
  });

  it("lists Serve handlers with Funnel, TCP forwards and foreground sessions", () => {
    expect(parseServeConfig(SERVE)).toEqual([
      {
        host: "pi.tail1234.ts.net",
        port: 443,
        path: "/",
        kind: "proxy",
        target: "http://127.0.0.1:7470",
        funnel: true,
      },
      {
        host: "pi.tail1234.ts.net",
        port: 443,
        path: "/docs",
        kind: "files",
        target: null,
        funnel: true,
      },
      {
        host: "pi.tail1234.ts.net",
        port: 443,
        path: "/hello",
        kind: "text",
        target: null,
        funnel: true,
      },
      { host: "", port: 2222, path: "", kind: "tcp", target: "127.0.0.1:22", funnel: false },
      {
        host: "pi.tail1234.ts.net",
        port: 8443,
        path: "/",
        kind: "proxy",
        target: "3000",
        funnel: false,
      },
    ]);
    expect(parseServeConfig({})).toEqual([]);
    expect(parseServeConfig({ Web: { "bad-key": { Handlers: { "/": { Proxy: "1" } } } } })).toEqual(
      [],
    );
  });

  it("describes peers: path, idle, last seen, online first", () => {
    const { peers } = parseTailscalePeers(STATUS);
    expect(peers.map((p) => [p.hostName, p.connection, p.relay])).toEqual([
      ["laptop", "direct", "fra"],
      ["phone", "relay", "ams"],
      ["old-desktop", "idle", null],
    ]);
    expect(peers[0]).toMatchObject({
      dnsName: "laptop.tail1234.ts.net",
      lastSeen: null,
      rxBytes: 1024,
    });
    expect(peers[2]).toMatchObject({
      online: false,
      lastSeen: Date.parse("2026-09-01T12:00:00Z"),
      keyExpiry: Date.parse("2027-01-01T00:00:00Z"),
    });
    expect(JSON.stringify(peers)).not.toContain("secret-should-not-leak");
  });

  it("reads the LocalAPI over its socket and copes with refused optional endpoints", async () => {
    const socket = await fakeLocalApi({
      "/localapi/v0/status?peers=false": { body: STATUS },
      "/localapi/v0/status?peers=true": { body: STATUS },
      "/localapi/v0/prefs": { status: 403, body: { error: "access denied" } },
      "/localapi/v0/serve-config": { body: SERVE },
    });
    const details = await getTailscaleDetails([socket]);
    expect(details.status).toEqual({ available: true });
    expect(details.prefs.available).toBe(false);
    expect(details.serve.handlers).toHaveLength(5);
    expect((await getTailscalePeers([socket])).peers).toHaveLength(3);

    const missing = await getTailscaleDetails([join(tmpdir(), "no-such-tailscaled.sock")]);
    expect(missing.status).toEqual({ available: false, reason: "not-detected" });
  });
});
