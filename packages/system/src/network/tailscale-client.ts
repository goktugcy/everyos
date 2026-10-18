import { request } from "node:http";
import type {
  TailscaleDetails,
  TailscalePeers,
  TailscaleServeRefusal,
  TailscaleStatus,
} from "@everyos/shared";
import { pathKind } from "../fs-utils.ts";
import {
  parseTailscaleDetails,
  parseTailscalePeers,
  parseTailscaleStatus,
  tailscaleDetailsUnavailable,
  tailscaleUnavailable,
} from "../linux/tailscale.ts";

const SOCKETS = ["/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock"];
const MAX_BYTES = 4 * 1024 * 1024;

function getJson(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      // LocalAPI requires this exact Host header.
      {
        socketPath,
        path,
        method: "GET",
        headers: { Host: "local-tailscaled.sock" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy(new Error("response too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              Object.assign(new Error(`LocalAPI ${res.statusCode}`), { status: res.statusCode }),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Invalid Tailscale status response"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

type Unavailable = "socket-missing" | "permission-denied" | "not-detected";

async function findSocket(
  sockets: readonly string[],
): Promise<{ socket: string } | { reason: Unavailable }> {
  let denied = false;
  for (const candidate of sockets) {
    const kind = await pathKind(candidate);
    if (kind === "socket") return { socket: candidate };
    if (kind === "denied") denied = true;
  }
  return { reason: denied ? "permission-denied" : "not-detected" };
}

const failure = (error: unknown): Unavailable => {
  const code = (error as NodeJS.ErrnoException).code;
  const status = (error as { status?: number }).status;
  return code === "EACCES" || status === 403 ? "permission-denied" : "socket-missing";
};

/** Tailscale status from tailscaled's LocalAPI (no CLI parsing, no network access). */
export async function getTailscaleStatus(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscaleStatus> {
  const found = await findSocket(sockets);
  if ("reason" in found) return tailscaleUnavailable(found.reason);
  const { socket } = found;
  try {
    return parseTailscaleStatus(await getJson(socket, "/localapi/v0/status?peers=true", 5_000));
  } catch (error) {
    return tailscaleUnavailable(failure(error));
  }
}

/** Status, preferences and Serve configuration of this node (read-only LocalAPI calls). */
export async function getTailscaleDetails(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscaleDetails> {
  const found = await findSocket(sockets);
  if ("reason" in found) return tailscaleDetailsUnavailable(found.reason);
  const { socket } = found;
  let status: unknown;
  try {
    status = await getJson(socket, "/localapi/v0/status?peers=false", 5_000);
  } catch (error) {
    return tailscaleDetailsUnavailable(failure(error));
  }
  // Older versions or restricted access may refuse these; the rest still shows.
  const [prefs, serve] = await Promise.all([
    getJson(socket, "/localapi/v0/prefs", 5_000).catch(() => null),
    getJson(socket, "/localapi/v0/serve-config", 5_000).catch(() => null),
  ]);
  return parseTailscaleDetails(status, prefs, serve);
}

/** The tailnet's other devices. */
export async function getTailscalePeers(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscalePeers> {
  const found = await findSocket(sockets);
  if ("reason" in found) return { status: { available: false, reason: found.reason }, peers: [] };
  const { socket } = found;
  try {
    return parseTailscalePeers(await getJson(socket, "/localapi/v0/status?peers=true", 5_000));
  } catch (error) {
    return { status: { available: false, reason: failure(error) }, peers: [] };
  }
}

/* ------------------------------------------------------- EveryOS's Serve handler */

/** Why EveryOS's Serve handler could not be changed (TAILSCALE_SERVE_REFUSALS, or no socket). */
export class TailscaleServeError extends Error {
  readonly reason: TailscaleServeRefusal | Unavailable;
  constructor(reason: TailscaleServeRefusal | Unavailable, message: string) {
    super(message);
    this.reason = reason;
  }
}

function localApi(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; etag: string | null; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          Host: "local-tailscaled.sock",
          ...(body !== undefined
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
        timeout: 8_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy(new Error("response too large"));
          else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            etag: typeof res.headers.etag === "string" ? res.headers.etag : null,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

/**
 * Turns EveryOS's Serve handler on (`https://<node>.<tailnet>.ts.net/` → the API on loopback,
 * with the tailnet's own certificate) or off. Only that handler is ever added or removed: other
 * handlers stay, a port 443 used by something else is refused, and Funnel is never turned on.
 */
export async function setTailscaleServe(
  input: { enabled: boolean; port: number },
  sockets: readonly string[] = SOCKETS,
): Promise<{ url: string | null }> {
  const found = await findSocket(sockets);
  if ("reason" in found) throw new TailscaleServeError(found.reason, "Tailscale is not available");
  const { socket } = found;
  let status: Json;
  try {
    status = record(await getJson(socket, "/localapi/v0/status?peers=false", 5_000));
  } catch (error) {
    throw new TailscaleServeError(failure(error), "Tailscale status is not readable");
  }
  const dnsName =
    typeof record(status.Self).DNSName === "string"
      ? (record(status.Self).DNSName as string).replace(/\.$/, "").toLowerCase()
      : "";
  if (status.BackendState !== "Running" || !/^[a-z0-9.-]{1,253}$/.test(dnsName))
    throw new TailscaleServeError("not-running", "Tailscale is not connected");
  const current = await localApi(socket, "GET", "/localapi/v0/serve-config");
  if (current.status === 403)
    throw new TailscaleServeError("permission-denied", "Serve settings are not readable");
  if (current.status !== 200)
    throw new TailscaleServeError("socket-missing", `Serve settings answered ${current.status}`);
  const config = record(current.text ? JSON.parse(current.text) : {});
  const target = `http://127.0.0.1:${input.port}`;
  const hostPort = `${dnsName}:443`;
  const web = { ...record(config.Web) };
  const site = record(web[hostPort]);
  const handlers = { ...record(site.Handlers) };
  const tcp = { ...record(config.TCP) };
  const ours = record(handlers["/"]).Proxy === target;

  if (input.enabled) {
    const certDomains = Array.isArray(status.CertDomains) ? status.CertDomains : [];
    if (!certDomains.some((domain) => String(domain).toLowerCase() === dnsName))
      throw new TailscaleServeError("https-disabled", "HTTPS certificates are off for the tailnet");
    if (record(config.AllowFunnel)[hostPort] === true)
      throw new TailscaleServeError("funnel", "Port 443 is published on the internet");
    const port443 = record(tcp["443"]);
    if (
      (tcp["443"] !== undefined && port443.HTTPS !== true) ||
      typeof port443.TCPForward === "string" ||
      (handlers["/"] !== undefined && !ours)
    )
      throw new TailscaleServeError("port-in-use", "Port 443 already serves something else");
    if (ours && port443.HTTPS === true) return { url: `https://${dnsName}` };
    tcp["443"] = { ...port443, HTTPS: true };
    web[hostPort] = { ...site, Handlers: { ...handlers, "/": { Proxy: target } } };
  } else {
    if (!ours) return { url: null };
    delete handlers["/"];
    if (Object.keys(handlers).length > 0) web[hostPort] = { ...site, Handlers: handlers };
    else {
      delete web[hostPort];
      if (!Object.keys(web).some((key) => key.endsWith(":443"))) delete tcp["443"];
    }
  }
  const next: Json = { ...config, TCP: tcp, Web: web };
  if (Object.keys(tcp).length === 0) delete next.TCP;
  if (Object.keys(web).length === 0) delete next.Web;
  const saved = await localApi(
    socket,
    "POST",
    "/localapi/v0/serve-config",
    JSON.stringify(next),
    current.etag ? { "If-Match": current.etag } : {},
  );
  if (saved.status === 412)
    throw new TailscaleServeError("port-in-use", "Serve settings changed meanwhile; try again");
  if (saved.status === 403)
    throw new TailscaleServeError("permission-denied", "Serve settings are not writable");
  if (saved.status < 200 || saved.status >= 300)
    throw new TailscaleServeError("socket-missing", `Serve settings answered ${saved.status}`);
  return { url: input.enabled ? `https://${dnsName}` : null };
}
