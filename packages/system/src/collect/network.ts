import { connect } from "node:net";
import * as os from "node:os";
import type { InternetState, NetworkInterfaceKind, NetworkStatus } from "@otuken/shared";
import { listDirOrEmpty, pathKind, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import { parseIpv4Routes, parseIpv6Routes, parseResolvConf } from "../linux/procfs.ts";

type InterfaceInfo = NetworkStatus["interfaces"][number];

async function classify(
  paths: HostPaths,
  name: string,
): Promise<{ kind: NetworkInterfaceKind; physical: boolean }> {
  const base = hostPath(paths, `/sys/class/net/${name}`);
  // Hardware NICs link to their bus device; software links (veth, bridges,
  // tunnels, container networks) live under /sys/devices/virtual.
  const physical = (await pathKind(`${base}/device`)) === "directory";
  if (name === "lo") return { kind: "loopback", physical: false };
  if (name.startsWith("tailscale")) return { kind: "tailscale", physical: false };
  if ((await pathKind(`${base}/wireless`)) === "directory") return { kind: "wireless", physical };
  if ((await pathKind(`${base}/bridge`)) === "directory")
    return { kind: "bridge", physical: false };
  if (!physical) return { kind: "virtual", physical: false };
  const type = (await readTextOrNull(`${base}/type`, 16))?.trim();
  return { kind: type === "1" ? "ethernet" : "other", physical: true };
}

function addressesOf(name: string): InterfaceInfo["addresses"] {
  return (os.networkInterfaces()[name] ?? []).slice(0, 64).map((entry) => ({
    family: entry.family === "IPv6" ? ("ipv6" as const) : ("ipv4" as const),
    address: entry.address.split("%")[0]!,
    prefix: Number(entry.cidr?.split("/")[1] ?? 0),
  }));
}

async function linuxInterfaces(paths: HostPaths): Promise<InterfaceInfo[]> {
  const base = hostPath(paths, "/sys/class/net");
  const names = (await listDirOrEmpty(base)).sort().slice(0, 256);
  const out: InterfaceInfo[] = [];
  for (const name of names) {
    const dir = `${base}/${name}`;
    const [operstate, mac, mtu, speed, { kind, physical }] = await Promise.all([
      readTextOrNull(`${dir}/operstate`, 32),
      readTextOrNull(`${dir}/address`, 64),
      readTextOrNull(`${dir}/mtu`, 16),
      readTextOrNull(`${dir}/speed`, 16),
      classify(paths, name),
    ]);
    const speedValue = Number(speed?.trim());
    const state = operstate?.trim();
    out.push({
      name,
      kind,
      // Loopback and many virtual links report "unknown" while working.
      up: state === "up" || (state === "unknown" && addressesOf(name).length > 0),
      mac: mac?.trim() && mac.trim() !== "00:00:00:00:00:00" ? mac.trim() : null,
      mtu: Number(mtu?.trim()) || null,
      // Software links report a nominal speed (e.g. 10000) that means nothing.
      speedMbps: physical && Number.isFinite(speedValue) && speedValue > 0 ? speedValue : null,
      addresses: addressesOf(name),
    });
  }
  return out;
}

function nodeInterfaces(): InterfaceInfo[] {
  return Object.entries(os.networkInterfaces()).map(([name, entries]) => ({
    name,
    kind: entries?.some((e) => e.internal) ? ("loopback" as const) : ("other" as const),
    up: true,
    mac: entries?.find((e) => e.mac && e.mac !== "00:00:00:00:00:00")?.mac ?? null,
    mtu: null,
    speedMbps: null,
    addresses: addressesOf(name),
  }));
}

export interface InternetProbeResult {
  state: InternetState;
  checkedAt: number | null;
  latencyMs: number | null;
}

/** TCP reachability of one public endpoint ("host:port"). */
function probe(target: string, timeoutMs: number): Promise<number | null> {
  const index = target.lastIndexOf(":");
  const host = target.slice(0, index).replace(/^\[(.*)\]$/, "$1");
  const port = Number(target.slice(index + 1));
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (result: number | null) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(Math.round(performance.now() - started)));
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
  });
}

/**
 * Checks internet reachability (separate from "has a LAN address") with a
 * short TCP connect to public endpoints. Results are cached so the network
 * is not probed more than once per `maxAgeMs`.
 */
export function createInternetProbe(
  targets: readonly string[],
  maxAgeMs = 60_000,
  now: () => number = Date.now,
) {
  let cached: InternetProbeResult = {
    state: targets.length === 0 ? "disabled" : "unknown",
    checkedAt: null,
    latencyMs: null,
  };
  let inflight: Promise<InternetProbeResult> | null = null;
  return async (): Promise<InternetProbeResult> => {
    if (targets.length === 0) return cached;
    if (cached.checkedAt !== null && now() - cached.checkedAt < maxAgeMs) return cached;
    inflight ??= (async () => {
      let latency: number | null = null;
      for (const target of targets) {
        latency = await probe(target, 2_500);
        if (latency !== null) break;
      }
      cached = {
        state: latency === null ? "offline" : "online",
        checkedAt: now(),
        latencyMs: latency,
      };
      inflight = null;
      return cached;
    })();
    return inflight;
  };
}

/** Interfaces, default gateways, DNS servers and internet reachability. */
export async function collectNetwork(options: {
  paths?: HostPaths;
  internet: () => Promise<InternetProbeResult>;
}): Promise<NetworkStatus> {
  const paths = options.paths ?? REAL_HOST;
  if (paths.platform !== "linux") {
    return {
      source: "host",
      interfaces: nodeInterfaces(),
      gateways: [],
      dns: [],
      internet: await options.internet(),
    };
  }
  const read = (path: string) => readTextOrNull(hostPath(paths, path), 128 * 1024);
  const [interfaces, routes4, routes6, resolved, resolv, internet] = await Promise.all([
    linuxInterfaces(paths),
    read("/proc/net/route"),
    read("/proc/net/ipv6_route"),
    read("/run/systemd/resolve/resolv.conf"),
    read("/etc/resolv.conf"),
    options.internet(),
  ]);
  return {
    source: "host",
    interfaces,
    gateways: [
      ...parseIpv4Routes(routes4 ?? "").map((route) => ({ ...route, family: "ipv4" as const })),
      ...parseIpv6Routes(routes6 ?? "").map((route) => ({ ...route, family: "ipv6" as const })),
    ].slice(0, 32),
    // With systemd-resolved, /etc/resolv.conf only names the local stub (127.0.0.53).
    dns: parseResolvConf(resolved ?? resolv ?? ""),
    internet,
  };
}
