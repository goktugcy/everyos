import { describe, expect, it, vi } from "vitest";
import { RemoteAccessNodeSchema, RemoteAccessPeersSchema } from "@everyos/shared/schemas";
import {
  parseTailscaleDetails,
  parseTailscaleStatus,
  tailscaleUnavailable,
} from "../linux/tailscale.ts";
import {
  getTailscaleDetails,
  getTailscaleStatus,
  getTailscalePeers,
} from "../network/tailscale-client.ts";
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
  getTailscaleRemoteState: async () => ({
    status: await getTailscaleStatus(),
    details: await getTailscaleDetails(),
  }),
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
  it("distinguishes a Tailscale exit-node server from a client consuming an exit node", async () => {
    vi.mocked(getTailscaleStatus).mockResolvedValue(
      parseTailscaleStatus({
        BackendState: "Running",
        Self: { ExitNodeOption: true },
      }),
    );
    vi.mocked(getTailscaleDetails).mockResolvedValue(
      parseTailscaleDetails(
        { Self: { ExitNodeOption: true } },
        { AdvertiseRoutes: ["0.0.0.0/0", "::/0"], CorpDNS: true, RouteAll: false },
        {},
      ),
    );
    expect(await createRemoteAccessDrivers(dependencies()).tailscale.status()).toMatchObject({
      state: "connected",
      advertisesExitNode: true,
      defaultRoute: false,
    });
  });
  it("does not report 'No' for exit-node use when Tailscale telemetry is unavailable", async () => {
    vi.mocked(getTailscaleStatus).mockResolvedValue(tailscaleUnavailable("permission-denied"));
    vi.mocked(getTailscaleDetails).mockResolvedValue(parseTailscaleDetails({}, null, null));
    expect(await createRemoteAccessDrivers(dependencies()).tailscale.status()).toMatchObject({
      available: false,
      defaultRoute: null,
    });
  });
  it("reconnects only NetBird so saved configuration is applied to an already-connected client", async () => {
    const deps = dependencies();
    await createRemoteAccessDrivers(deps).netbird.connect(
      { managementUrl: "https://vpn.example.test", acceptDNS: false, acceptRoutes: false },
      undefined,
      new AbortController().signal,
    );
    expect(vi.mocked(deps.capture).mock.calls.map(([, args]) => args)).toEqual([
      ["down"],
      [
        "up",
        "--no-browser",
        "--disable-dns=true",
        "--disable-client-routes=true",
        "--management-url",
        "https://vpn.example.test",
      ],
    ]);
  });
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
    expect(parseNetBirdStatus({ ...raw, daemonStatus: "FutureErrorState" }).state).toBe("unknown");
    expect(
      parseNetBirdStatus({
        daemonStatus: "Idle",
        management: { url: "https://user:password@host.test" },
      }).managementUrl,
    ).toBeNull();
  });
  it("passes enrollment keys only through stdin and never starts or changes the other provider", async () => {
    const deps = dependencies(),
      driver = createRemoteAccessDrivers(deps).netbird;
    vi.mocked(deps.run).mockImplementation((_file, args) =>
      Promise.resolve(
        args.includes("--json")
          ? JSON.stringify({ ...raw, daemonStatus: "Idle" })
          : "--disable-dns --disable-client-routes --no-browser --setup-key-file",
      ),
    );
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
      ["up"],
    ]);
  });
  it("shows a selected exit node independently of local advertisement and preserves unknown preferences", async () => {
    vi.mocked(getTailscaleStatus).mockResolvedValue(
      parseTailscaleStatus({
        BackendState: "Running",
        ExitNodeStatus: { ID: "fixture-exit", Online: true },
      }),
    );
    vi.mocked(getTailscaleDetails).mockResolvedValue(parseTailscaleDetails({}, null, null));
    expect(await createRemoteAccessDrivers(dependencies()).tailscale.status()).toMatchObject({
      defaultRoute: true,
      advertisesExitNode: null,
      dnsEnabled: null,
      acceptsRoutes: null,
    });
  });
  it("reports Tailscale approval requirements and refuses unintended key-based enrollment of a registered device", async () => {
    const deps = dependencies(),
      driver = createRemoteAccessDrivers(deps).tailscale;
    const settings = { managementUrl: null, acceptDNS: false, acceptRoutes: false };
    vi.mocked(getTailscaleDetails).mockResolvedValue(parseTailscaleDetails({}, null, null));
    for (const [backendState, expected] of [
      ["NeedsMachineAuth", "REMOTE_APPROVAL_REQUIRED"],
      ["Stopped", "REMOTE_ALREADY_REGISTERED"],
    ]) {
      vi.mocked(getTailscaleStatus).mockResolvedValue(
        parseTailscaleStatus({ BackendState: backendState }),
      );
      await expect(
        driver.connect(settings, "fixture-key", new AbortController().signal),
      ).rejects.toThrow(expected);
    }
    vi.mocked(getTailscaleStatus).mockResolvedValue(
      parseTailscaleStatus({ BackendState: "NeedsLogin" }),
    );
    await expect(driver.connect(settings, undefined, new AbortController().signal)).rejects.toThrow(
      "REMOTE_AUTH_REQUIRED",
    );
    expect(deps.capture).not.toHaveBeenCalled();
    await driver.connect(settings, "fixture-key", new AbortController().signal);
    const [file, args, options] = vi.mocked(deps.capture).mock.calls[0]!;
    expect(file).toBe("/fixture/python3");
    expect(args.slice(3)).toEqual([
      "/fixture/tailscale",
      "up",
      "--timeout=30s",
      "--accept-dns=false",
      "--accept-routes=false",
      "--auth-key=file:/dev/stdin",
    ]);
    expect(options.input).toBe("fixture-key\n");
    expect(args.join(" ")).not.toContain("fixture-key");
  });
  it("treats malformed NetBird telemetry and unreadable Tailscale peers as failures rather than empty success", async () => {
    for (const value of [null, [], {}, { peers: { total: 2 } }])
      expect(() => parseNetBirdStatus(value)).toThrow("REMOTE_STATUS_UNAVAILABLE");
    const malformed = parseNetBirdStatus({
      ...raw,
      netbirdIp: "100.80.0.1/bad",
      peers: { total: Infinity, connected: NaN },
    });
    expect(malformed.addresses).toEqual(["fd00::1/64"]);
    expect(malformed.peers).toEqual({ total: 0, online: 0 });
    vi.mocked(getTailscalePeers).mockResolvedValue({
      status: { available: false, reason: "permission-denied" },
      peers: [],
    });
    await expect(createRemoteAccessDrivers(dependencies()).tailscale.peers()).rejects.toThrow(
      "REMOTE_STATUS_UNAVAILABLE",
    );
    const deps = dependencies();
    vi.mocked(deps.run).mockResolvedValue("{}");
    await expect(createRemoteAccessDrivers(deps).netbird.peers()).rejects.toThrow(
      "REMOTE_STATUS_UNAVAILABLE",
    );
  });
  it("does not run VPN commands if the selected daemon remains unavailable after starting its fixed service", async () => {
    const deps = dependencies();
    vi.mocked(deps.run).mockImplementation((_file, args) =>
      args.includes("--json")
        ? Promise.reject(new Error("fixture daemon unavailable"))
        : Promise.resolve(""),
    );
    await expect(
      createRemoteAccessDrivers(deps).netbird.connect(
        { managementUrl: "https://api.netbird.io", acceptDNS: false, acceptRoutes: false },
        "fixture-key",
        new AbortController().signal,
      ),
    ).rejects.toThrow("REMOTE_DAEMON_UNAVAILABLE");
    expect(
      vi
        .mocked(deps.run)
        .mock.calls.some(
          ([file, args]) =>
            file === "/fixture/systemctl" && args.join(" ") === "start netbird.service",
        ),
    ).toBe(true);
    expect(deps.capture).not.toHaveBeenCalled();
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
