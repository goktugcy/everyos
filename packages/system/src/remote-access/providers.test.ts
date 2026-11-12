import { describe, expect, it, vi } from "vitest";
import { RemoteAccessNodeSchema, RemoteAccessPeersSchema } from "@everyos/shared/schemas";
import { parseTailscaleDetails, parseTailscaleStatus } from "../linux/tailscale.ts";
import { getTailscaleDetails, getTailscaleStatus } from "../network/tailscale-client.ts";
import {
  createRemoteAccessDrivers,
  emptyRemoteNode,
  parseNetBirdPeers,
  parseNetBirdStatus,
  withRemoteRoutes,
  type RemoteAccessDependencies,
} from "./providers.ts";

vi.mock("../network/tailscale-client.ts", () => ({
  getTailscaleStatus: vi.fn(),
  getTailscaleDetails: vi.fn(),
  getTailscalePeers: vi.fn(),
}));
const raw = {
  daemonStatus: "Connected",
  daemonVersion: "0.61.0",
  management: { url: "https://vpn.example.test", connected: true },
  netbirdIp: "100.80.0.1/16",
  netbirdIpv6: "fd00::1/64",
  fqdn: "server.netbird.cloud",
  dnsServers: [{ enabled: true, servers: ["secret nameserver"] }],
  networks: ["10.1.0.0/16", "bad", "::/999"],
  privateKey: "never-return",
  peers: {
    total: 1,
    connected: 1,
    details: [
      {
        fqdn: "laptop.netbird.cloud",
        netbirdIp: "100.80.0.2/16",
        status: "Connected",
        connectionType: "Relayed",
        transferReceived: 42,
        transferSent: 24,
        lastStatusUpdate: "2026-11-01T00:00:00Z",
        publicKey: "never-return",
        sshSessions: [{ user: "never-return" }],
      },
    ],
  },
};
function dependencies(): RemoteAccessDependencies {
  return {
    find: vi.fn<RemoteAccessDependencies["find"]>((name) =>
      Promise.resolve(name === "ip" ? null : `/fixture/${name}`),
    ),
    run: vi.fn<RemoteAccessDependencies["run"]>((_file, args) =>
      Promise.resolve(
        args.includes("--json")
          ? JSON.stringify(raw)
          : "--disable-dns --disable-client-routes --no-browser --setup-key-file",
      ),
    ),
    capture: vi.fn<RemoteAccessDependencies["capture"]>(() =>
      Promise.resolve({ exitCode: 0, output: "discarded" }),
    ),
    interfaces: () => ({}),
  };
}
describe("remote provider adapters", () => {
  it("reads upstream NetBird JSON through an allowlist and supports older status responses", () => {
    const node = parseNetBirdStatus(raw),
      peers = parseNetBirdPeers(raw);
    expect(RemoteAccessNodeSchema.safeParse(node).success).toBe(true);
    expect(RemoteAccessPeersSchema.safeParse({ peers }).success).toBe(true);
    expect(node).toMatchObject({
      state: "connected",
      dnsEnabled: true,
      managementUrl: "https://vpn.example.test",
      routes: [],
      routeVisibility: false,
      defaultRoute: null,
    });
    expect(parseNetBirdStatus({ ...raw, dnsServers: [], networks: ["0.0.0.0/0"] })).toMatchObject({
      dnsEnabled: null,
      defaultRoute: null,
    });
    expect(peers[0]).toMatchObject({ online: true, connection: "relay", rxBytes: 42, txBytes: 24 });
    expect(JSON.stringify([node, peers])).not.toMatch(/never-return|nameserver|sshSessions/);
    expect(parseNetBirdStatus({ management: { connected: true } }).state).toBe("connected");
    expect(parseNetBirdStatus({ daemonStatus: "SessionExpired" }).state).toBe("needs-login");
    expect(
      parseNetBirdStatus({ management: { url: "https://user:password@host.test" } }).managementUrl,
    ).toBeNull();
  });
  it("passes enrollment keys only through stdin and never starts or changes the other provider", async () => {
    const deps = dependencies(),
      driver = createRemoteAccessDrivers(deps).netbird;
    await driver.connect(
      { managementUrl: "https://vpn.example.test:443", acceptDNS: false, acceptRoutes: true },
      "secret-fixture-key",
      new AbortController().signal,
    );
    const call = vi.mocked(deps.capture).mock.calls[0]!;
    expect(call[0]).toBe("/fixture/python3");
    expect(call[1].slice(0, 2)).toEqual(["-I", "-c"]);
    expect(call[1].slice(3)).toEqual([
      "/fixture/netbird",
      "up",
      "--no-browser",
      "--disable-dns=true",
      "--disable-client-routes=false",
      "--management-url",
      "https://vpn.example.test:443",
      "--setup-key-file",
      "/dev/stdin",
    ]);
    expect(call[2]?.input).toBe("secret-fixture-key\n");
    expect(JSON.stringify(call.slice(0, 2))).not.toContain("secret-fixture-key");
    expect(call[2]?.env).toBeUndefined();
    await driver.disconnect(new AbortController().signal);
    expect(vi.mocked(deps.capture).mock.calls[1]?.[1]).toEqual(["down"]);
    expect(vi.mocked(deps.run).mock.calls.every(([file]) => file.endsWith("netbird"))).toBe(true);
  });
  it("refuses unsupported client flags and redacts command failure output", async () => {
    const deps = dependencies(),
      driver = createRemoteAccessDrivers(deps).netbird;
    const settings = { managementUrl: null, acceptDNS: false, acceptRoutes: false };
    vi.mocked(deps.run).mockImplementation((_file, args) =>
      Promise.resolve(args.includes("--json") ? JSON.stringify(raw) : "old help"),
    );
    await expect(driver.connect(settings, "key", new AbortController().signal)).rejects.toThrow(
      "REMOTE_VERSION_UNSUPPORTED",
    );
    expect(deps.capture).not.toHaveBeenCalled();
    vi.mocked(deps.capture).mockRejectedValue(new Error("private credential was rejected"));
    await expect(driver.disconnect(new AbortController().signal)).rejects.toThrow(
      /^REMOTE_COMMAND_FAILED$/,
    );
  });
  it("preserves Tailscale settings outside DNS and route acceptance when reconnecting", async () => {
    vi.mocked(getTailscaleStatus).mockResolvedValue(
      parseTailscaleStatus({ BackendState: "Stopped", TailscaleIPs: ["100.64.0.1"] }),
    );
    vi.mocked(getTailscaleDetails).mockResolvedValue(
      parseTailscaleDetails(
        {},
        { CorpDNS: true, RouteAll: false, RunSSH: true, AdvertiseRoutes: ["10.0.0.0/8"] },
        {},
      ),
    );
    const deps = dependencies();
    await createRemoteAccessDrivers(deps).tailscale.connect(
      { managementUrl: null, acceptDNS: false, acceptRoutes: true },
      undefined,
      new AbortController().signal,
    );
    expect(vi.mocked(deps.capture).mock.calls.map(([, args]) => args)).toEqual([
      ["set", "--accept-dns=false", "--accept-routes=true"],
      ["up", "--timeout=30s"],
    ]);
  });
  it("correlates route interfaces, handles identical IPv4/IPv6 output and split default routes", async () => {
    const deps = dependencies();
    deps.find = () => Promise.resolve("/fixture/ip");
    deps.interfaces = () => ({
      wgTest: [
        {
          address: "100.80.0.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.80.0.1/16",
        },
      ],
    });
    vi.mocked(deps.run).mockResolvedValue(
      JSON.stringify([
        { dst: "default", dev: "wgTest" },
        { dst: "10.0.0.0/8", dev: "eth0" },
      ]),
    );
    const node = {
      ...emptyRemoteNode("netbird"),
      state: "connected" as const,
      addresses: ["100.80.0.1/16"],
    };
    expect(await withRemoteRoutes(node, deps)).toMatchObject({
      routes: ["0.0.0.0/0", "::/0"],
      routeVisibility: true,
      defaultRoute: true,
    });
    vi.mocked(deps.run).mockImplementation((_file, args) =>
      Promise.resolve(
        JSON.stringify(
          args.includes("-6")
            ? []
            : [
                { dst: "0.0.0.0/1", dev: "wgTest" },
                { dst: "128.0.0.0/1", dev: "wgTest" },
              ],
        ),
      ),
    );
    expect((await withRemoteRoutes(node, deps)).defaultRoute).toBe(true);
    vi.mocked(deps.run).mockRejectedValue(new Error("permission denied"));
    expect(await withRemoteRoutes(node, deps)).toMatchObject({
      routeVisibility: false,
      defaultRoute: null,
    });
    deps.interfaces = () => {
      throw new Error("unavailable");
    };
    expect((await withRemoteRoutes(node, deps)).routeVisibility).toBe(false);
  });
});
