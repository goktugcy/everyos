import type { TailscaleStatus } from "@otuken/shared";

const str = (value: unknown, max = 256): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

const strings = (value: unknown, limit: number, max = 64): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .slice(0, limit)
        .map((v) => v.slice(0, max))
    : [];

/**
 * Tailscale LocalAPI `GET /localapi/v0/status` → the subset Otuken shows.
 * Unknown fields are ignored; nothing about other devices beyond counts is kept.
 */
export function parseTailscaleStatus(json: unknown): TailscaleStatus {
  const data = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const self = (data.Self ?? {}) as Record<string, unknown>;
  const tailnet = (data.CurrentTailnet ?? null) as Record<string, unknown> | null;
  const exit = (data.ExitNodeStatus ?? null) as Record<string, unknown> | null;
  const peers = (
    typeof data.Peer === "object" && data.Peer !== null ? Object.values(data.Peer) : []
  ) as Array<Record<string, unknown>>;
  const exitPeer = peers.find((peer) => peer.ExitNode === true);
  const dnsName = str(self.DNSName);
  return {
    status: { available: true },
    backendState: str(data.BackendState, 64),
    version: str(data.Version, 64),
    hostName: str(self.HostName),
    dnsName: dnsName ? dnsName.replace(/\.$/, "") : null,
    tailnet: str(tailnet?.Name),
    ips: strings(self.TailscaleIPs ?? data.TailscaleIPs, 8),
    online: typeof self.Online === "boolean" ? self.Online : null,
    exitNode: {
      active: exit !== null || exitPeer !== undefined,
      name: exitPeer ? (str(exitPeer.HostName) ?? str(exitPeer.DNSName)) : null,
      online:
        typeof exit?.Online === "boolean"
          ? exit.Online
          : typeof exitPeer?.Online === "boolean"
            ? exitPeer.Online
            : null,
    },
    peers: { total: peers.length, online: peers.filter((peer) => peer.Online === true).length },
    health: strings(data.Health, 32, 512),
  };
}

export function tailscaleUnavailable(
  reason: "socket-missing" | "permission-denied" | "not-detected",
): TailscaleStatus {
  return {
    status: { available: false, reason },
    backendState: null,
    version: null,
    hostName: null,
    dnsName: null,
    tailnet: null,
    ips: [],
    online: null,
    exitNode: { active: false, name: null, online: null },
    peers: { total: 0, online: 0 },
    health: [],
  };
}
