import type {
  TailscaleDetails,
  TailscaleRemoteAccess,
  TailscaleStatus,
  TailscaleWarning,
} from "@otuken/shared";

const DAY = 24 * 60 * 60_000;
/** Warn this long before the node key expires (remote access stops then). */
export const KEY_EXPIRY_WARNING_MS = 14 * DAY;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);

/** Where a Serve proxy or TCP forward points (`7470`, `localhost:7470`, `http://127.0.0.1:7470`). */
export function serveTarget(target: string): { host: string; port: number } | null {
  if (/^\d{1,5}$/.test(target)) return { host: "127.0.0.1", port: Number(target) };
  try {
    const url = new URL(/^[a-z][a-z+.-]*:\/\//i.test(target) ? target : `http://${target}`);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

export interface TailscaleAnalysis {
  remoteAccess: TailscaleRemoteAccess;
  warnings: TailscaleWarning[];
}

/**
 * Explains what the Tailscale state means for this Otuken: whether it is
 * published on the tailnet (Serve) or the internet (Funnel), whether the
 * configuration matches (public origins, trusted proxy), and what needs
 * attention. Read-only: nothing here changes Tailscale or Otuken.
 */
export function analyzeTailscale(input: {
  status: TailscaleStatus;
  details: TailscaleDetails;
  server: { port: number; publicOrigins: readonly string[] };
  isTrustedProxy: (address: string) => boolean;
  now: number;
}): TailscaleAnalysis {
  const { status, details, server, now } = input;
  const warnings: TailscaleWarning[] = [];
  const ownAddresses = new Set([...LOCAL_HOSTS, ...status.ips]);
  const toOtuken = details.serve.handlers.filter((handler) => {
    if (handler.kind !== "proxy" && handler.kind !== "tcp") return false;
    const target = handler.target ? serveTarget(handler.target) : null;
    return target !== null && target.port === server.port && ownAddresses.has(target.host);
  });
  const origins = new Set(server.publicOrigins.map((origin) => origin.toLowerCase()));
  const urls = toOtuken
    .filter((handler) => handler.kind === "proxy" && handler.host)
    .map((handler) => {
      const origin = `https://${handler.host}${handler.port === 443 ? "" : `:${handler.port}`}`;
      return {
        url: `${origin}${handler.path === "/" ? "" : handler.path}`,
        funnel: handler.funnel,
        originAllowed: origins.has(origin.toLowerCase()),
      };
    });
  const proxyTrusted = input.isTrustedProxy("127.0.0.1");

  if (status.status.available) {
    const state = status.backendState ?? "unknown";
    if (state === "NeedsLogin" || state === "NeedsMachineAuth")
      warnings.push({ kind: "needs-login", severity: "warning", params: { state } });
    else if (state !== "Running")
      warnings.push({ kind: "not-running", severity: "warning", params: { state } });
    if (details.self.keyExpired)
      warnings.push({ kind: "key-expired", severity: "critical", params: {} });
    else if (
      details.self.keyExpiry !== null &&
      details.self.keyExpiry - now < KEY_EXPIRY_WARNING_MS
    )
      warnings.push({
        kind: "key-expiring",
        severity: "warning",
        params: {
          days: Math.max(0, Math.floor((details.self.keyExpiry - now) / DAY)),
          at: details.self.keyExpiry,
        },
      });
    if (status.exitNode.active && status.exitNode.online === false)
      warnings.push({
        kind: "exit-node-offline",
        severity: "warning",
        params: { name: status.exitNode.name ?? "" },
      });
    for (const handler of toOtuken.filter((entry) => entry.funnel)) {
      const host = handler.host || status.dnsName || "";
      warnings.push({
        kind: "funnel-public",
        severity: "critical",
        params: { url: `https://${host}${handler.port === 443 ? "" : `:${handler.port}`}` },
      });
    }
    for (const entry of urls.filter((url) => !url.originAllowed))
      warnings.push({ kind: "origin-missing", severity: "warning", params: { url: entry.url } });
    if (urls.length > 0 && !proxyTrusted)
      warnings.push({ kind: "proxy-untrusted", severity: "warning", params: {} });
    for (const message of status.health.slice(0, 5))
      warnings.push({ kind: "health", severity: "info", params: { message } });
  }

  return {
    remoteAccess: {
      port: server.port,
      urls,
      proxyTrusted,
      suggestion:
        urls.length === 0 && status.backendState === "Running" && status.dnsName
          ? {
              url: `https://${status.dnsName}`,
              command: `tailscale serve --bg --https=443 http://127.0.0.1:${server.port}`,
            }
          : null,
    },
    warnings,
  };
}
