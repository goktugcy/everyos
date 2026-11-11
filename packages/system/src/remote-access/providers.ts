import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type {
  RemoteAccessNode,
  RemoteAccessPeer,
  RemoteAccessProviderId,
  RemoteAccessSettings,
} from "@everyos/shared";
import { findExecutable, runCommand, runCapture, type CaptureResult } from "../exec.ts";
import { parseOsRelease } from "../parsers.ts";
import {
  getTailscaleStatus,
  getTailscaleDetails,
  getTailscalePeers,
} from "../network/tailscale-client.ts";

export class RemoteAccessError extends Error {
  constructor(readonlyCode: string) {
    super(readonlyCode);
    this.name = "RemoteAccessError";
  }
}
export interface RemoteAccessDriver {
  readonly id: RemoteAccessProviderId;
  status(): Promise<RemoteAccessNode>;
  peers(): Promise<RemoteAccessPeer[]>;
  connect(
    settings: RemoteAccessSettings,
    credential: string | undefined,
    signal: AbortSignal,
  ): Promise<RemoteAccessNode>;
  disconnect(signal: AbortSignal): Promise<RemoteAccessNode>;
}
export const emptyRemoteNode = (provider: RemoteAccessProviderId): RemoteAccessNode => ({
  provider,
  source: "host",
  installed: false,
  available: false,
  reason: "not-installed",
  state: "unknown",
  version: null,
  hostName: null,
  addresses: [],
  managementUrl: null,
  dnsEnabled: null,
  acceptsRoutes: null,
  routes: [],
  defaultRoute: null,
  routeVisibility: false,
  peers: { total: 0, online: 0 },
  installationSupported: false,
});
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max = 256) =>
  typeof value === "string" ? value.slice(0, max) : null;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const address = (value: unknown): string[] =>
  typeof value === "string" && isIP(value.split("/")[0]!) ? [value.slice(0, 128)] : [];
const cidr = (value: unknown): boolean => {
  if (typeof value !== "string" || value.length > 128) return false;
  const [ip, prefix, extra] = value.split("/");
  const family = ip && !ip.includes("%") ? isIP(ip) : 0;
  return Boolean(
    family &&
    prefix &&
    /^\d+$/.test(prefix) &&
    extra === undefined &&
    Number(prefix) <= (family === 4 ? 32 : 128),
  );
};

/** Allowlisted public fields only: no WireGuard keys, login tokens, endpoint or debug dumps. */
export function parseNetBirdStatus(value: unknown): RemoteAccessNode {
  const raw = record(value),
    management = record(raw.management),
    peers = record(raw.peers);
  const state = text(raw.daemonStatus, 64);
  return {
    ...emptyRemoteNode("netbird"),
    installed: true,
    available: true,
    reason: null,
    state:
      state === "Connected"
        ? "connected"
        : state === "Connecting"
          ? "connecting"
          : ["NeedsLogin", "LoginFailed", "SessionExpired"].includes(state ?? "")
            ? "needs-login"
            : state === "Idle"
              ? "disconnected"
              : management.connected === true
                ? "connected"
                : "unknown",
    version: text(raw.daemonVersion, 128) ?? text(raw.cliVersion, 128),
    hostName: text(raw.fqdn),
    addresses: [...address(raw.netbirdIp), ...address(raw.netbirdIpv6)],
    managementUrl: safeManagementOrigin(management.url),
    // Empty DNS groups do not prove that NetBird's local DNS resolver is disabled.
    dnsEnabled: list(raw.dnsServers).some((v) => record(v).enabled === true) ? true : null,
    // The CLI's local "networks" lists advertised routes, not necessarily accepted routes.
    // Effective client routes are collected from the kernel by withRemoteRoutes.
    peers: { total: Math.floor(count(peers.total)), online: Math.floor(count(peers.connected)) },
  };
}
export function parseNetBirdPeers(value: unknown): RemoteAccessPeer[] {
  return list(record(record(value).peers).details)
    .slice(0, 500)
    .map((value) => {
      const peer = record(value),
        state = text(peer.status),
        connection = text(peer.connectionType);
      const at =
        typeof peer.lastStatusUpdate === "string" ? Date.parse(peer.lastStatusUpdate) : NaN;
      return {
        name: text(peer.fqdn),
        addresses: [...address(peer.netbirdIp), ...address(peer.netbirdIpv6)],
        online: state === "Connected" ? true : state ? false : null,
        connection:
          connection === "P2P"
            ? "direct"
            : connection === "Relayed"
              ? "relay"
              : state === "Idle"
                ? "idle"
                : "unknown",
        lastSeen: Number.isFinite(at) && at >= 0 ? at : null,
        rxBytes: count(peer.transferReceived),
        txBytes: count(peer.transferSent),
      };
    });
}
function safeManagementOrigin(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
export interface RemoteAccessDependencies {
  find: typeof findExecutable;
  run: typeof runCommand;
  capture: typeof runCapture;
  interfaces: typeof networkInterfaces;
  tailscaleSockets?: readonly string[];
}
const defaults: RemoteAccessDependencies = {
  find: findExecutable,
  run: runCommand,
  capture: runCapture,
  interfaces: networkInterfaces,
};

/** Correlate routes with actual local VPN addresses, rather than assuming an interface name. */
export async function withRemoteRoutes(
  node: RemoteAccessNode,
  deps: RemoteAccessDependencies,
): Promise<RemoteAccessNode> {
  const ip = await deps.find("ip");
  if (!ip || node.state !== "connected") return node;
  const addresses = new Set(node.addresses.map((v) => v.split("/")[0]));
  try {
    const interfaces = Object.entries(deps.interfaces())
      .filter(([, values]) => values?.some((entry) => addresses.has(entry.address)))
      .map(([name]) => name);
    if (!interfaces.length) return node;
    const outputs = await Promise.all(
      [[], ["-6"]].map((family) =>
        deps.run(ip, [...family, "-j", "route", "show", "table", "all"], {
          timeoutMs: 5_000,
          maxBytes: 4 * 1024 * 1024,
        }),
      ),
    );
    const routes = [
      ...new Set(
        outputs.flatMap((output, index) =>
          list(JSON.parse(output)).flatMap((value) => {
            const route = record(value);
            if (
              !interfaces.includes(String(route.dev)) ||
              ["local", "broadcast", "unreachable", "blackhole"].includes(String(route.type))
            )
              return [];
            const destination =
              route.dst === "default" ? (index === 1 ? "::/0" : "0.0.0.0/0") : text(route.dst, 128);
            if (destination && cidr(destination)) return [destination];
            return destination && isIP(destination)
              ? [`${destination}/${isIP(destination) === 4 ? 32 : 128}`]
              : [];
          }),
        ),
      ),
    ].slice(0, 128);
    const split = (a: string, b: string) => routes.includes(a) && routes.includes(b);
    return {
      ...node,
      routes,
      routeVisibility: true,
      defaultRoute:
        node.defaultRoute === true ||
        routes.includes("0.0.0.0/0") ||
        routes.includes("::/0") ||
        split("0.0.0.0/1", "128.0.0.0/1") ||
        split("::/1", "8000::/1"),
      acceptsRoutes: node.acceptsRoutes,
    };
  } catch {
    return node;
  }
}

export function createRemoteAccessDrivers(
  overrides: Partial<RemoteAccessDependencies> = {},
): Record<RemoteAccessProviderId, RemoteAccessDriver> {
  const deps = { ...defaults, ...overrides };
  const mutate = async (
    provider: RemoteAccessProviderId,
    args: string[],
    signal: AbortSignal,
    credential?: string,
  ): Promise<CaptureResult> => {
    const executable = await deps.find(provider);
    if (!executable) throw new RemoteAccessError("REMOTE_NOT_INSTALLED");
    try {
      const result = await deps.capture(executable, args, {
        signal,
        timeoutMs: 55_000,
        maxOutputBytes: 16 * 1024,
        ...(credential ? { input: credential + "\n" } : {}),
      });
      if (result.exitCode !== 0) throw new RemoteAccessError("REMOTE_COMMAND_FAILED");
      return { exitCode: 0, output: "" };
    } catch (error) {
      if (error instanceof RemoteAccessError) throw error;
      throw new RemoteAccessError("REMOTE_COMMAND_FAILED");
    }
  };
  const supportsInstallation = async () => {
    if (process.platform !== "linux" || !(await deps.find("apt-get"))) return false;
    try {
      return ["debian", "ubuntu"].includes(
        parseOsRelease(await readFile("/etc/os-release", "utf8")).ID ?? "",
      );
    } catch {
      return false;
    }
  };
  const installed = async (node: RemoteAccessNode) => ({
    ...node,
    installationSupported: await supportsInstallation(),
    installed: node.installed || Boolean(await deps.find(node.provider)),
  });
  const netbirdRead = async () => {
    const executable = await deps.find("netbird");
    if (!executable) throw new RemoteAccessError("REMOTE_NOT_INSTALLED");
    return JSON.parse(
      await deps.run(executable, ["status", "--json"], {
        timeoutMs: 8_000,
        maxBytes: 4 * 1024 * 1024,
      }),
    ) as unknown;
  };
  const drivers: Record<RemoteAccessProviderId, RemoteAccessDriver> = {
    tailscale: {
      id: "tailscale",
      async status() {
        const [status, details] = await Promise.all([
          getTailscaleStatus(deps.tailscaleSockets),
          getTailscaleDetails(deps.tailscaleSockets),
        ]);
        const node: RemoteAccessNode = {
          ...emptyRemoteNode("tailscale"),
          installed: status.status.available,
          available: status.status.available,
          reason: status.status.available ? null : "daemon-unavailable",
          state:
            status.backendState === "Running"
              ? "connected"
              : status.backendState === "NeedsLogin"
                ? "needs-login"
                : status.backendState === "Stopped"
                  ? "disconnected"
                  : status.backendState === "Starting"
                    ? "connecting"
                    : "unknown",
          version: status.version,
          hostName: status.hostName,
          addresses: status.ips,
          dnsEnabled: details.prefs.acceptDNS,
          acceptsRoutes: details.prefs.acceptRoutes,
          defaultRoute: status.exitNode.active,
          peers: status.peers,
        };
        const result = await installed(node);
        if (!result.installed) result.reason = "not-installed";
        return withRemoteRoutes(result, deps);
      },
      async peers() {
        return (await getTailscalePeers(deps.tailscaleSockets)).peers.map((p) => ({
          name: p.dnsName ?? p.hostName,
          addresses: p.ips,
          online: p.online,
          connection: p.connection,
          lastSeen: p.lastSeen,
          rxBytes: p.rxBytes,
          txBytes: p.txBytes,
        }));
      },
      async connect(settings, credential, signal) {
        let state = await this.status();
        if (!state.installed) throw new RemoteAccessError("REMOTE_NOT_INSTALLED");
        if (!state.available) {
          await start("tailscaled.service", signal);
          state = await this.status();
        }
        if (state.state === "needs-login" && !credential)
          throw new RemoteAccessError("REMOTE_AUTH_REQUIRED");
        if (state.state !== "needs-login" && state.state !== "unknown") {
          await mutate(
            "tailscale",
            [
              "set",
              `--accept-dns=${settings.acceptDNS}`,
              `--accept-routes=${settings.acceptRoutes}`,
            ],
            signal,
          );
          await mutate(
            "tailscale",
            ["up", "--timeout=30s", ...(credential ? ["--auth-key=file:/dev/stdin"] : [])],
            signal,
            credential,
          );
        } else
          await mutate(
            "tailscale",
            [
              "up",
              "--timeout=30s",
              `--accept-dns=${settings.acceptDNS}`,
              `--accept-routes=${settings.acceptRoutes}`,
              ...(credential ? ["--auth-key=file:/dev/stdin"] : []),
            ],
            signal,
            credential,
          );
        return this.status();
      },
      async disconnect(signal) {
        await mutate("tailscale", ["down"], signal);
        return this.status();
      },
    },
    netbird: {
      id: "netbird",
      async status() {
        let node: RemoteAccessNode;
        try {
          node = parseNetBirdStatus(await netbirdRead());
        } catch {
          node = { ...emptyRemoteNode("netbird"), installed: Boolean(await deps.find("netbird")) };
          node.reason = node.installed ? "daemon-unavailable" : "not-installed";
        }
        return withRemoteRoutes(await installed(node), deps);
      },
      async peers() {
        try {
          return parseNetBirdPeers(await netbirdRead());
        } catch {
          throw new RemoteAccessError("REMOTE_STATUS_UNAVAILABLE");
        }
      },
      async connect(settings, credential, signal) {
        let state = await this.status();
        if (!state.installed) throw new RemoteAccessError("REMOTE_NOT_INSTALLED");
        if (!state.available) {
          await start("netbird.service", signal);
          state = await this.status();
        }
        if (state.state === "needs-login" && !credential)
          throw new RemoteAccessError("REMOTE_AUTH_REQUIRED");
        const binary = await deps.find("netbird");
        if (!binary) throw new RemoteAccessError("REMOTE_NOT_INSTALLED");
        const help = await deps.run(binary, ["up", "--help"], {
          timeoutMs: 5_000,
          maxBytes: 128 * 1024,
        });
        if (
          !["--disable-dns", "--disable-client-routes", "--no-browser"].every((flag) =>
            help.includes(flag),
          ) ||
          (credential &&
            !(
              await deps.run(binary, ["--help"], { timeoutMs: 5_000, maxBytes: 128 * 1024 })
            ).includes("--setup-key-file"))
        )
          throw new RemoteAccessError("REMOTE_VERSION_UNSUPPORTED");
        await mutate(
          "netbird",
          [
            "up",
            "--no-browser",
            `--disable-dns=${!settings.acceptDNS}`,
            `--disable-client-routes=${!settings.acceptRoutes}`,
            ...(settings.managementUrl ? ["--management-url", settings.managementUrl] : []),
            ...(credential ? ["--setup-key-file", "/dev/stdin"] : []),
          ],
          signal,
          credential,
        );
        return this.status();
      },
      async disconnect(signal) {
        await mutate("netbird", ["down"], signal);
        return this.status();
      },
    },
  };
  async function start(unit: "netbird.service" | "tailscaled.service", signal: AbortSignal) {
    const systemctl = await deps.find("systemctl");
    if (!systemctl) throw new RemoteAccessError("REMOTE_DAEMON_UNAVAILABLE");
    try {
      await deps.run(systemctl, ["start", unit], { signal, timeoutMs: 15_000, maxBytes: 4096 });
    } catch {
      throw new RemoteAccessError("REMOTE_DAEMON_UNAVAILABLE");
    }
  }
  return drivers;
}
