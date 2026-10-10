import { isIP } from "node:net";

export interface ClientInfo {
  /** Best-effort client address (after resolving trusted proxies). */
  ip: string;
  /** True when the browser-facing connection is HTTPS. */
  secure: boolean;
  /** True when the client is on the loopback interface. */
  loopback: boolean;
  /** Host the browser used (Host or trusted X-Forwarded-Host). */
  host: string | null;
  /** Origin the browser is expected to send for same-origin requests. */
  expectedOrigin: string | null;
}

export interface ConnectionFacts {
  remoteAddress: string | undefined;
  encrypted: boolean;
}

export function normalizeAddress(address: string | undefined): string {
  if (!address) return "unknown";
  // IPv4-mapped IPv6 (::ffff:192.0.2.1) → 192.0.2.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  return address === "::1";
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

const HOST_PATTERN = /^[a-z0-9.\-[\]:]+$/i;

/**
 * Determines who is calling and over which transport. Forwarded headers are
 * honoured only when the direct peer is a configured trusted proxy; otherwise
 * they are ignored, because any client can set them.
 */
export function resolveClientInfo(
  connection: ConnectionFacts,
  headers: (name: string) => string | undefined,
  isTrustedProxy: (address: string) => boolean,
): ClientInfo {
  const peer = normalizeAddress(connection.remoteAddress);
  let ip = peer;
  let secure = connection.encrypted;
  let host = headers("host") ?? null;

  if (isTrustedProxy(peer)) {
    const chain = (headers("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => normalizeAddress(part.trim()))
      .filter((part) => isIP(part) !== 0);
    // Walk from the nearest hop outward; the first untrusted hop is the client.
    for (let i = chain.length - 1; i >= 0; i--) {
      ip = chain[i]!;
      if (!isTrustedProxy(ip)) break;
    }
    const proto = firstHeaderValue(headers("x-forwarded-proto"))?.toLowerCase();
    if (proto === "https" || proto === "http") secure = proto === "https";
    host = firstHeaderValue(headers("x-forwarded-host")) ?? host;
  }

  if (host && !HOST_PATTERN.test(host)) host = null;
  return {
    ip,
    secure,
    loopback: isLoopbackAddress(ip),
    host,
    expectedOrigin: host ? `${secure ? "https" : "http"}://${host.toLowerCase()}` : null,
  };
}
