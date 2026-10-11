import type {
  TailscaleDetails,
  TailscalePeer,
  TailscalePeers,
  TailscaleStatus,
} from "@everyos/shared";

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
 * Tailscale LocalAPI `GET /localapi/v0/status` → the subset EveryOS shows.
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

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** Go timestamps; the zero time ("0001-01-01…") means "never". */
const time = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const EXIT_ROUTES = new Set(["0.0.0.0/0", "::/0"]);

type ServeHandler = TailscaleDetails["serve"]["handlers"][number];

function splitHostPort(value: string): { host: string; port: number } | null {
  const index = value.lastIndexOf(":");
  const port = Number(value.slice(index + 1));
  if (index <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: value.slice(0, index).slice(0, 256), port };
}

/** Handlers of a Serve configuration (`/localapi/v0/serve-config`), foreground sessions included. */
export function parseServeConfig(json: unknown, depth = 0): ServeHandler[] {
  const config = object(json);
  const funnel = object(config.AllowFunnel);
  const handlers: ServeHandler[] = [];
  for (const [hostPort, raw] of Object.entries(object(config.Web))) {
    const address = splitHostPort(hostPort);
    if (!address) continue;
    for (const [path, entry] of Object.entries(object(object(raw).Handlers))) {
      const handler = object(entry);
      const kind: ServeHandler["kind"] | null =
        typeof handler.Proxy === "string"
          ? "proxy"
          : typeof handler.Path === "string"
            ? "files"
            : typeof handler.Text === "string"
              ? "text"
              : null;
      if (!kind) continue;
      handlers.push({
        host: address.host,
        port: address.port,
        path: path.slice(0, 256),
        kind,
        target: kind === "proxy" ? (handler.Proxy as string).slice(0, 512) : null,
        funnel: funnel[hostPort] === true,
      });
    }
  }
  for (const [portText, raw] of Object.entries(object(config.TCP))) {
    const port = Number(portText);
    const forward = object(raw).TCPForward;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof forward !== "string")
      continue;
    handlers.push({
      host: "",
      port,
      path: "",
      kind: "tcp",
      target: forward.slice(0, 512),
      funnel: Object.entries(funnel).some(([key, on]) => on === true && key.endsWith(`:${port}`)),
    });
  }
  // `tailscale serve` without --bg keeps its configuration per foreground session.
  if (depth === 0)
    for (const session of Object.values(object(config.Foreground)))
      handlers.push(...parseServeConfig(session, 1));
  return handlers.slice(0, 64);
}

/**
 * This node in detail, from LocalAPI status, preferences and Serve
 * configuration. Preferences and Serve are optional (older versions or
 * restricted access); only the fields EveryOS shows are kept.
 */
export function parseTailscaleDetails(
  statusJson: unknown,
  prefsJson: unknown,
  serveJson: unknown,
): TailscaleDetails {
  const data = object(statusJson);
  const self = object(data.Self);
  const tailnet = data.CurrentTailnet ? object(data.CurrentTailnet) : null;
  const prefs = prefsJson === null ? null : object(prefsJson);
  const advertised = strings(prefs?.AdvertiseRoutes, 64);
  return {
    status: { available: true },
    self: {
      os: str(self.OS, 64),
      relay: str(self.Relay, 64),
      keyExpiry: time(self.KeyExpiry),
      keyExpired: self.Expired === true,
      exitNodeOption: self.ExitNodeOption === true,
      routes: strings(self.PrimaryRoutes, 64).filter((route) => !EXIT_ROUTES.has(route)),
      tags: strings(self.Tags, 32, 128),
      magicDNS: tailnet ? bool(tailnet.MagicDNSEnabled) : null,
      magicDNSSuffix: str(tailnet?.MagicDNSSuffix ?? data.MagicDNSSuffix),
    },
    prefs: prefs
      ? {
          available: true,
          ssh: bool(prefs.RunSSH),
          shieldsUp: bool(prefs.ShieldsUp),
          acceptRoutes: bool(prefs.RouteAll),
          acceptDNS: bool(prefs.CorpDNS),
          advertisedRoutes: advertised.filter((route) => !EXIT_ROUTES.has(route)),
          advertisesExitNode: advertised.some((route) => EXIT_ROUTES.has(route)),
          exitNodeAllowLAN: bool(prefs.ExitNodeAllowLANAccess),
        }
      : unavailablePrefs(),
    serve:
      serveJson === null
        ? { available: false, handlers: [] }
        : { available: true, handlers: parseServeConfig(serveJson) },
  };
}

const unavailablePrefs = (): TailscaleDetails["prefs"] => ({
  available: false,
  ssh: null,
  shieldsUp: null,
  acceptRoutes: null,
  acceptDNS: null,
  advertisedRoutes: [],
  advertisesExitNode: null,
  exitNodeAllowLAN: null,
});

export function tailscaleDetailsUnavailable(
  reason: "socket-missing" | "permission-denied" | "not-detected",
): TailscaleDetails {
  return {
    status: { available: false, reason },
    self: {
      os: null,
      relay: null,
      keyExpiry: null,
      keyExpired: false,
      exitNodeOption: false,
      routes: [],
      tags: [],
      magicDNS: null,
      magicDNSSuffix: null,
    },
    prefs: unavailablePrefs(),
    serve: { available: false, handlers: [] },
  };
}

/** The other devices of the tailnet (online first), without keys or user details. */
export function parseTailscalePeers(json: unknown): TailscalePeers {
  const peers = Object.values(object(object(json).Peer))
    .slice(0, 500)
    .map((raw): TailscalePeer => {
      const peer = object(raw);
      const dnsName = str(peer.DNSName);
      const active = peer.Active === true;
      return {
        hostName: str(peer.HostName),
        dnsName: dnsName ? dnsName.replace(/\.$/, "") : null,
        os: str(peer.OS, 64),
        ips: strings(peer.TailscaleIPs, 4),
        online: bool(peer.Online),
        active,
        lastSeen: time(peer.LastSeen),
        exitNode: peer.ExitNode === true,
        exitNodeOption: peer.ExitNodeOption === true,
        connection: !active ? "idle" : str(peer.CurAddr) ? "direct" : "relay",
        relay: str(peer.Relay, 64),
        rxBytes: typeof peer.RxBytes === "number" && peer.RxBytes >= 0 ? peer.RxBytes : 0,
        txBytes: typeof peer.TxBytes === "number" && peer.TxBytes >= 0 ? peer.TxBytes : 0,
        keyExpiry: time(peer.KeyExpiry),
        tags: strings(peer.Tags, 32, 128),
      };
    })
    .sort(
      (a, b) =>
        Number(b.online === true) - Number(a.online === true) ||
        (a.hostName ?? "").localeCompare(b.hostName ?? ""),
    );
  return { status: { available: true }, peers };
}
