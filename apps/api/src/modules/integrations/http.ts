import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { addressAllowed } from "@everyos/catalogs";

export class IntegrationHttpError extends Error {
  readonly kind: "offline" | "auth" | "status" | "invalid" | "unsafe-address" | "too-large";
  readonly status: number | null;

  constructor(kind: IntegrationHttpError["kind"], message: string, status: number | null = null) {
    super(message);
    this.name = "IntegrationHttpError";
    this.kind = kind;
    this.status = status;
  }
}

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Test hook. */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

/**
 * Requests to a self-hosted app configured by an administrator. Local and
 * private addresses are allowed (that is where the apps live); link-local
 * and cloud metadata addresses never are. DNS is resolved once and pinned,
 * redirects are not followed, and responses are size- and time-limited.
 */
export async function resolveIntegrationAddress(target: URL, resolve?: HttpOptions["resolve"]) {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await (resolve ?? ((name) => lookup(name, { all: true, verbatim: true })))(hostname);
  } catch {
    throw new IntegrationHttpError("offline", "Host name could not be resolved");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !addressAllowed(address, true)))
    throw new IntegrationHttpError("unsafe-address", "Address not allowed");
  return addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
}

export async function requestBytes(
  url: string,
  options: HttpOptions = {},
): Promise<{ status: number; bytes: Buffer }> {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new IntegrationHttpError("invalid", "Unsupported URL");
  const pinned = await resolveIntegrationAddress(target, options.resolve);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 6_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  const maxBytes = options.maxBytes ?? 1024 * 1024;

  return new Promise((resolve, reject) => {
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: options.method ?? "GET",
        signal,
        agent: false,
        family: pinned.family,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: {
          Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
          "Accept-Encoding": "identity",
          "User-Agent": "EveryOS-Widgets/1",
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": String(body.length) }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) {
          response.destroy();
          reject(new IntegrationHttpError("auth", "The app rejected the credentials", status));
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new IntegrationHttpError("status", `The app answered HTTP ${status}`, status));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy();
            reject(new IntegrationHttpError("too-large", "Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, bytes: Buffer.concat(chunks) }));
        response.on("error", () => reject(new IntegrationHttpError("offline", "Connection lost")));
      },
    );
    req.on("error", () => reject(new IntegrationHttpError("offline", "The app is not reachable")));
    req.end(body ?? undefined);
  });
}

export async function requestText(url: string, options: HttpOptions = {}) {
  const { status, bytes } = await requestBytes(url, options);
  return { status, text: bytes.toString("utf8") };
}

export async function requestJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const { text } = await requestText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IntegrationHttpError("invalid", "The app returned invalid JSON");
  }
}

/** Joins a configured base URL (which may contain a sub-path) with an API path. */
export function joinUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const target = new URL(path.replace(/^\//, ""), url);
  for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, value);
  return target.toString();
}
