import type { NetTlsTarget, TlsCertificate } from "@everyos/app-sdk";

export interface Endpoint {
  host: string;
  port: number;
  servername: string | null;
}
export interface Draft {
  host: string;
  port: string;
  servername: string;
}
export const EMPTY_DRAFT: Draft = { host: "", port: "443", servername: "" };
export const MAX_ENDPOINTS = 50;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_NAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

function hostName(input: string, allowIp: boolean): string | null {
  const value = input.trim().replace(/\.$/, "");
  if (!value || /[\s/@?#%\\]/.test(value)) return null;
  if (IPV4.test(value)) return allowIp ? value : null;
  if (value.includes(":")) {
    if (!allowIp) return null;
    if (value.startsWith("[") && !value.endsWith("]")) return null;
    try {
      const url = new URL(`https://${value.startsWith("[") ? value : `[${value}]`}/`);
      return url.hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  try {
    const ascii = new URL(`https://${value}/`).hostname;
    if (!HOST_NAME.test(ascii)) return null;
    return ascii;
  } catch {
    return null;
  }
}

/** Client validation improves feedback; the server independently checks target policy. */
export function parseEndpoint(draft: Draft): Endpoint | null {
  const host = hostName(draft.host, true);
  const port = /^\d{1,5}$/.test(draft.port) ? Number(draft.port) : 0;
  const servername = draft.servername.trim() ? hostName(draft.servername, false) : null;
  return host && port >= 1 && port <= 65535 && (!draft.servername.trim() || servername)
    ? { host, port, servername }
    : null;
}
export const endpointKey = (target: Endpoint) =>
  JSON.stringify([target.host, target.port, target.servername]);
export const endpointLabel = (target: Endpoint) =>
  `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
export const endpointDraft = (target: Endpoint): Draft => ({
  host: target.host,
  port: String(target.port),
  servername: target.servername ?? "",
});
export const tlsInput = (target: Endpoint): NetTlsTarget => ({ ...target, timeoutMs: 10000 });

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export function readDraft(value: unknown): Draft {
  const v = object(value);
  return {
    host: typeof v.host === "string" ? v.host.slice(0, 1024) : "",
    port: typeof v.port === "string" ? v.port.slice(0, 8) : "443",
    servername: typeof v.servername === "string" ? v.servername.slice(0, 1024) : "",
  };
}
export function readEndpoints(value: unknown): Endpoint[] {
  if (!Array.isArray(value)) return [];
  const endpoints = new Map<string, Endpoint>();
  for (const item of value.slice(0, MAX_ENDPOINTS)) {
    const v = object(item);
    if (
      typeof v.host !== "string" ||
      typeof v.port !== "number" ||
      !(v.servername === null || typeof v.servername === "string")
    )
      continue;
    const target = parseEndpoint({
      host: v.host,
      port: String(v.port),
      servername: v.servername ?? "",
    });
    if (target) endpoints.set(endpointKey(target), target);
  }
  return [...endpoints.values()];
}
export type Validity = "expired" | "future" | "soon" | "valid";
export function validity(
  cert: Pick<TlsCertificate, "validFrom" | "validTo">,
  now: number,
): Validity {
  if (cert.validTo <= now) return "expired";
  if (cert.validFrom > now) return "future";
  return cert.validTo - now <= 30 * 86400000 ? "soon" : "valid";
}
