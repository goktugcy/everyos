import { randomUUID, X509Certificate } from "node:crypto";
import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { checkServerIdentity, connect as tlsConnect, type DetailedPeerCertificate } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type {
  DnsRecord,
  HttpHeader,
  NetDnsResult,
  NetFailure,
  NetHttpResponse,
  NetTlsResult,
  TlsCertificate,
} from "@everyos/app-sdk/protocol";
import { NET_LIMITS } from "@everyos/app-sdk/protocol";
import { addressAllowed } from "@everyos/catalogs";
import type { Database } from "@everyos/database";
import type { DesktopAppNetworkRuleView } from "@everyos/shared";
import type {
  AppNetDnsInputSchema,
  AppNetHttpInputSchema,
  AppNetTlsInputSchema,
  DesktopAppNetworkRuleCreateSchema,
} from "@everyos/shared/schemas";
import type { z } from "zod";
import { ApiError, rateLimited } from "../../http/errors.ts";

/*
 * The network policy of desktop apps and the only ways they reach the network (docs/app-sdk/
 * network.md). Every target is checked against the administrator's rules after DNS resolution,
 * the connection is pinned to the checked address, and every redirect hop is checked again.
 * Requests are built from scratch: no EveryOS cookie, token or credential is ever sent.
 */

const MAX_RULES = 200;
/** Per app and person: requests per minute, and requests at once per person. */
const PER_MINUTE = 120;
const AT_ONCE = 4;

/** Request headers an app cannot set: the connection and framing are EveryOS's. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "http2-settings",
  "proxy-authorization",
  "proxy-connection",
]);
/** Dropped when a redirect leaves the origin, as browsers do. */
const ORIGIN_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

type RuleInput = z.output<typeof DesktopAppNetworkRuleCreateSchema>;
type HttpInput = z.output<typeof AppNetHttpInputSchema>;
type DnsInput = z.output<typeof AppNetDnsInputSchema>;
type TlsInput = z.output<typeof AppNetTlsInputSchema>;

interface RuleRow {
  id: string;
  kind: "host" | "cidr";
  pattern: string;
  ports: string;
  app_id: string | null;
  note: string | null;
  created_at: number;
  username: string | null;
}

interface Rule {
  kind: "host" | "cidr";
  pattern: string;
  ports: number[];
  list: BlockList | null;
}

export interface Pinned {
  host: string;
  address: string;
  family: 4 | 6;
}

export const networkBlocked = (host: string, port: number, reason: "policy" | "address") =>
  new ApiError(403, "DESKTOP_APP_NETWORK_BLOCKED", "The network policy does not allow this", {
    details: { host, port, reason },
  });

export const networkFailed = (reason: NetFailure, message?: string) =>
  new ApiError(502, "DESKTOP_APP_NETWORK_FAILED", "The network operation failed", {
    details: { reason, ...(message ? { message: message.slice(0, 200) } : {}) },
  });

/** A CIDR pattern as a block list, or null when it is not one (or too wide to be a scope). */
export function parseCidr(
  pattern: string,
): { list: BlockList; address: string; prefix: number } | null {
  const [address = "", bits = ""] = pattern.split("/");
  const version = isIP(address);
  const prefix = Number(bits);
  if (!version || !/^\d{1,3}$/.test(bits)) return null;
  // Narrow enough to be a deliberate scope: no "the whole internet" rules.
  if (version === 4 ? prefix < 8 || prefix > 32 : prefix < 32 || prefix > 128) return null;
  const list = new BlockList();
  list.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
  return { list, address, prefix };
}

/** `*.example.com` matches subdomains at any depth (not example.com itself). */
export function hostMatches(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : pattern === host;
}

const familyOf = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");

/** Addresses of this server (loopback and its interfaces). */
function ownAddresses(): string[] {
  const addresses = ["127.0.0.1", "::1"];
  for (const list of Object.values(networkInterfaces()))
    for (const entry of list ?? []) addresses.push(entry.address.split("%")[0] ?? "");
  return addresses.filter((address) => isIP(address));
}

function failureOf(error: unknown, timedOut: boolean): ApiError {
  if (error instanceof ApiError) return error;
  if (timedOut) return networkFailed("timeout");
  const code = (error as { code?: string }).code ?? "";
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA")
    return networkFailed("dns", code);
  if (code === "ECONNREFUSED") return networkFailed("refused", code);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL")
    return networkFailed("unreachable", code);
  if (code === "ETIMEDOUT" || code === "ABORT_ERR") return networkFailed("timeout", code);
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED")
    return networkFailed("reset", code);
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.startsWith("CERT_") ||
    code.includes("CERT") ||
    code.includes("SELF_SIGNED") ||
    code.startsWith("UNABLE_TO")
  )
    return networkFailed("tls", code || message);
  if (code.startsWith("HPE_") || code === "Z_DATA_ERROR" || code === "ERR_INVALID_HTTP_TOKEN")
    return networkFailed("invalid-response", code);
  return networkFailed("error", code || message);
}

const TEXT_TYPE =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|x-yaml|csv|graphql|x-ndjson|problem\+json)\b)/i;

/** Text when the response says (or looks) textual and decodes cleanly; base64 otherwise. */
function bodyOf(
  bytes: Buffer,
  contentType: string | undefined,
): { encoding: "text" | "base64"; data: string } {
  const charset = /charset="?([\w.:-]+)"?/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  const textual = contentType ? TEXT_TYPE.test(contentType.trim()) : true;
  if (textual) {
    try {
      const text = new TextDecoder(charset, { fatal: true }).decode(bytes);
      if (contentType || !text.includes("\0")) return { encoding: "text", data: text };
    } catch {
      // Not valid in its charset (or an unknown charset): bytes.
    }
  }
  return { encoding: "base64", data: bytes.toString("base64") };
}

function certificateOf(cert: DetailedPeerCertificate): TlsCertificate {
  const name = (value: Record<string, string | string[]> | undefined) =>
    Object.entries(value ?? {})
      .map(([key, entry]) => `${key}=${Array.isArray(entry) ? entry.join("+") : entry}`)
      .join(", ");
  const keyType = (() => {
    try {
      return new X509Certificate(cert.raw).publicKey.asymmetricKeyType ?? null;
    } catch {
      return null;
    }
  })();
  return {
    subject: name(cert.subject as unknown as Record<string, string | string[]>),
    issuer: name(cert.issuer as unknown as Record<string, string | string[]>),
    subjectAltNames: cert.subjectaltname ? cert.subjectaltname.split(", ") : [],
    validFrom: Date.parse(cert.valid_from),
    validTo: Date.parse(cert.valid_to),
    serialNumber: cert.serialNumber,
    fingerprint256: cert.fingerprint256,
    keyType,
    keyBits: typeof cert.bits === "number" ? cert.bits : null,
    selfSigned:
      cert.issuerCertificate === cert ||
      cert.issuerCertificate?.fingerprint256 === cert.fingerprint256,
  };
}

/**
 * Desktop apps' network access: the administrator's policy and the HTTP, TLS and DNS operations
 * behind `network:outbound`.
 */
export class AppNetwork {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  readonly #recent = new Map<string, number[]>();
  readonly #active = new Map<string, number>();

  constructor(options: {
    db: Database;
    now: () => number;
    /** DNS for policy checks (tests); the system resolver otherwise. */
    resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  }) {
    this.#db = options.db;
    this.#now = options.now;
    this.#resolve =
      options.resolve ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  }

  /* ---------------------------------------------------------------- rules */

  #view(row: RuleRow): DesktopAppNetworkRuleView {
    const cidr = row.kind === "cidr" ? parseCidr(row.pattern) : null;
    return {
      id: row.id,
      kind: row.kind,
      pattern: row.pattern,
      ports: JSON.parse(row.ports) as number[],
      appId: row.app_id,
      note: row.note,
      createdAt: row.created_at,
      createdBy: row.username,
      includesThisServer: cidr
        ? ownAddresses().some((address) => cidr.list.check(address, familyOf(address))) ||
          (isIP(cidr.address) === 4 && cidr.address.startsWith("127."))
        : false,
    };
  }

  rules(appId?: string): DesktopAppNetworkRuleView[] {
    return this.#db
      .all<RuleRow>(
        `SELECT r.*, u.username FROM desktop_app_network_rules r LEFT JOIN users u ON u.id = r.created_by
         ${appId === undefined ? "" : "WHERE r.app_id IS NULL OR r.app_id = ?"}
         ORDER BY r.app_id IS NOT NULL, r.app_id, r.kind, r.pattern`,
        ...(appId === undefined ? [] : [appId]),
      )
      .map((row) => this.#view(row));
  }

  addRule(input: RuleInput, userId: string): DesktopAppNetworkRuleView {
    if (input.kind === "cidr" && !parseCidr(input.pattern))
      throw new ApiError(400, "VALIDATION_FAILED", "Not a usable address range", {
        details: [{ path: "pattern", message: "IPv4 /8–/32 or IPv6 /32–/128" }],
      });
    if (
      input.appId &&
      !this.#db.get("SELECT 1 FROM desktop_app_installations WHERE app_id = ?", input.appId)
    )
      throw new ApiError(404, "NOT_FOUND", "App not found");
    const count = this.#db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM desktop_app_network_rules",
    );
    if ((count?.count ?? 0) >= MAX_RULES)
      throw new ApiError(409, "CONFLICT", "The network policy has too many rules");
    const ports = [...input.ports].sort((a, b) => a - b);
    const id = randomUUID();
    try {
      this.#db.run(
        "INSERT INTO desktop_app_network_rules(id, kind, pattern, ports, app_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.kind,
        input.pattern,
        JSON.stringify(ports),
        input.appId,
        input.note || null,
        userId,
        this.#now(),
      );
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new ApiError(409, "CONFLICT", "The same rule already exists");
      throw error;
    }
    return this.rules().find((rule) => rule.id === id)!;
  }

  removeRule(id: string): boolean {
    return this.#db.run("DELETE FROM desktop_app_network_rules WHERE id = ?", id).changes > 0;
  }

  #rulesFor(appId: string, port: number): Rule[] {
    return this.#db
      .all<{ kind: "host" | "cidr"; pattern: string; ports: string }>(
        "SELECT kind, pattern, ports FROM desktop_app_network_rules WHERE app_id IS NULL OR app_id = ?",
        appId,
      )
      .map((row) => ({
        kind: row.kind,
        pattern: row.pattern,
        ports: JSON.parse(row.ports) as number[],
        list: row.kind === "cidr" ? (parseCidr(row.pattern)?.list ?? null) : null,
      }))
      .filter((rule) => rule.ports.includes(port));
  }

  /**
   * Resolves a target and checks every address against the policy: a host rule allows public
   * addresses only; private, loopback and LAN addresses need a CIDR rule; link-local (cloud
   * metadata), unspecified, multicast and IPv4-mapped addresses are never allowed. The connection
   * must then use the returned address.
   */
  async target(appId: string, hostname: string, port: number): Promise<Pinned> {
    const host = hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.$/, "");
    const rules = this.#rulesFor(appId, port);
    const literal = isIP(host);
    const named =
      !literal && rules.some((rule) => rule.kind === "host" && hostMatches(rule.pattern, host));
    const ranges = rules.filter((rule) => rule.list);
    if (!named && !ranges.length) throw networkBlocked(host, port, "policy");
    let addresses: Array<{ address: string; family: number }>;
    if (literal) addresses = [{ address: host, family: literal }];
    else {
      try {
        addresses = await this.#resolve(host);
      } catch (error) {
        throw networkFailed("dns", (error as { code?: string }).code);
      }
    }
    if (!addresses.length) throw networkFailed("dns");
    for (const { address } of addresses) {
      if (!addressAllowed(address, true)) throw networkBlocked(host, port, "address");
      const inRange = ranges.some((rule) => rule.list!.check(address, familyOf(address)));
      if (!inRange && !(named && addressAllowed(address, false)))
        throw networkBlocked(host, port, named ? "address" : "policy");
    }
    const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
    return { host, address: pinned.address, family: pinned.family === 6 ? 6 : 4 };
  }

  /* ---------------------------------------------------------------- budget */

  /** Spends one request of the app's per-person budget; the returned function ends it. */
  #begin(appId: string, userId: string): () => void {
    const now = this.#now();
    const key = `${appId}:${userId}`;
    const recent = (this.#recent.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PER_MINUTE) throw rateLimited(60_000 - (now - recent[0]!));
    const active = this.#active.get(userId) ?? 0;
    if (active >= AT_ONCE) throw rateLimited(1000);
    recent.push(now);
    this.#recent.set(key, recent);
    this.#active.set(userId, active + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.#active.get(userId) ?? 1) - 1;
      if (left > 0) this.#active.set(userId, left);
      else this.#active.delete(userId);
    };
  }

  /* ---------------------------------------------------------------- HTTP */

  async http(
    appId: string,
    userId: string | null,
    input: HttpInput,
    signal?: AbortSignal,
  ): Promise<NetHttpResponse> {
    const end = userId ? this.#begin(appId, userId) : () => undefined;
    try {
      return await this.#http(appId, input, signal);
    } finally {
      end();
    }
  }

  async #http(appId: string, input: HttpInput, outer?: AbortSignal): Promise<NetHttpResponse> {
    let url = parseTarget(input.url);
    let method: string = input.method;
    let headers: HttpHeader[] = input.headers;
    for (const [name] of headers)
      if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith("proxy-"))
        throw new ApiError(400, "VALIDATION_FAILED", `The header ${name} is set by EveryOS`, {
          details: [{ path: "headers", message: name }],
        });
    if (
      headers.reduce((sum, [name, value]) => sum + name.length + value.length, 0) >
      NET_LIMITS.headerBytes
    )
      throw new ApiError(400, "VALIDATION_FAILED", "Headers are too large");
    let body: Buffer | null = input.body
      ? "text" in input.body
        ? Buffer.from(input.body.text, "utf8")
        : Buffer.from(input.body.base64, "base64")
      : null;
    if (body && body.length > NET_LIMITS.requestBodyBytes)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large");
    if (body && !headers.some(([name]) => name.toLowerCase() === "content-type"))
      headers = [
        ...headers,
        [
          "Content-Type",
          input.body && "text" in input.body
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
        ],
      ];
    const deadline = AbortSignal.timeout(input.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, deadline]) : deadline;
    const redirects: NetHttpResponse["redirects"] = [];
    for (let hop = 0; ; hop++) {
      const started = performance.now();
      let response: Exchange;
      try {
        const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
        const pinned = await this.target(appId, url.hostname, port);
        const dns = performance.now() - started;
        signal.throwIfAborted();
        response = await exchange(url, method, headers, body, pinned, input.verifyTls, signal, {
          started,
          dns,
          appId,
        });
      } catch (error) {
        if (outer?.aborted) throw error;
        throw failureOf(error, deadline.aborted);
      }
      const location = response.location;
      if (
        input.followRedirects &&
        location &&
        [301, 302, 303, 307, 308].includes(response.status)
      ) {
        if (hop >= NET_LIMITS.redirects) throw networkFailed("too-many-redirects");
        redirects.push({ url: url.href, status: response.status });
        let next: URL;
        try {
          next = parseTarget(new URL(location, url).href);
        } catch {
          throw networkFailed("invalid-response", "redirect");
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = null;
          headers = headers.filter(([name]) => name.toLowerCase() !== "content-type");
        }
        if (next.origin !== url.origin)
          headers = headers.filter(([name]) => !ORIGIN_HEADERS.has(name.toLowerCase()));
        url = next;
        continue;
      }
      return { ...response.result, url: url.href, redirects };
    }
  }

  /* ---------------------------------------------------------------- TLS */

  async tls(appId: string, userId: string, input: TlsInput): Promise<NetTlsResult> {
    const end = this.#begin(appId, userId);
    try {
      const started = performance.now();
      const pinned = await this.target(appId, input.host, input.port);
      const servername = input.servername ?? (isIP(pinned.host) ? null : pinned.host);
      return await new Promise<NetTlsResult>((resolve, reject) => {
        let timedOut = false;
        const socket = tlsConnect({
          host: pinned.address,
          port: input.port,
          ...(servername ? { servername } : {}),
          // Inspection, not trust: the verdict is reported (`authorized`), never acted on.
          rejectUnauthorized: false,
          ALPNProtocols: ["h2", "http/1.1"],
        });
        const timer = setTimeout(() => {
          timedOut = true;
          socket.destroy();
        }, input.timeoutMs);
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(failureOf(error, timedOut));
        });
        socket.once("close", () => {
          clearTimeout(timer);
          if (timedOut) reject(networkFailed("timeout"));
        });
        socket.once("secureConnect", () => {
          clearTimeout(timer);
          const leaf = socket.getPeerCertificate(true);
          const chain: TlsCertificate[] = [];
          const seen = new Set<string>();
          let cert: DetailedPeerCertificate | undefined = leaf;
          while (
            cert &&
            cert.fingerprint256 &&
            !seen.has(cert.fingerprint256) &&
            chain.length < 10
          ) {
            seen.add(cert.fingerprint256);
            chain.push(certificateOf(cert));
            cert = cert.issuerCertificate;
          }
          const cipher = socket.getCipher();
          const verifyName = servername ?? pinned.host;
          resolve({
            host: pinned.host,
            port: input.port,
            remoteAddress: pinned.address,
            protocol: socket.getProtocol(),
            cipher: cipher
              ? { name: cipher.name, standardName: cipher.standardName, version: cipher.version }
              : null,
            alpn: typeof socket.alpnProtocol === "string" ? socket.alpnProtocol : null,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError
              ? String(socket.authorizationError)
              : null,
            hostnameMatches:
              Boolean(leaf.raw) && checkServerIdentity(verifyName, leaf) === undefined,
            chain,
            ms: Math.round(performance.now() - started),
          });
          socket.end();
        });
      });
    } finally {
      end();
    }
  }

  /* ---------------------------------------------------------------- DNS */

  /**
   * A DNS query through the server's resolvers (any name: no connection is made to the target),
   * or through a chosen DNS server, which is a network target (port 53 unless chosen).
   */
  async dns(appId: string, userId: string, input: DnsInput): Promise<NetDnsResult> {
    const end = this.#begin(appId, userId);
    try {
      const resolver = new Resolver({ timeout: input.timeoutMs, tries: 1 });
      if (input.server) {
        const pinned = await this.target(appId, input.server, input.serverPort);
        resolver.setServers([
          pinned.family === 6
            ? `[${pinned.address}]:${input.serverPort}`
            : `${pinned.address}:${input.serverPort}`,
        ]);
      }
      const name = input.name.replace(/\.$/, "");
      const started = performance.now();
      const result = (status: NetDnsResult["status"], records: DnsRecord[]): NetDnsResult => ({
        name,
        type: input.type,
        servers: resolver.getServers(),
        status,
        ms: Math.round(performance.now() - started),
        records,
      });
      try {
        return result("ok", await query(resolver, input.type, name));
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        const status: NetDnsResult["status"] =
          code === "ENODATA"
            ? "no-data"
            : code === "ENOTFOUND"
              ? "not-found"
              : code === "EREFUSED"
                ? "refused"
                : code === "ESERVFAIL"
                  ? "server-failure"
                  : code === "ETIMEOUT" || code === "ECANCELLED"
                    ? "timeout"
                    : "error";
        return result(status, []);
      }
    } finally {
      end();
    }
  }
}

/** An http(s) URL an app may ask for: no credentials in it, no fragment. */
function parseTarget(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError(400, "VALIDATION_FAILED", "Not a URL", {
      details: [{ path: "url", message: "Not a URL" }],
    });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ApiError(400, "VALIDATION_FAILED", "Only http and https URLs without credentials", {
      details: [{ path: "url", message: "Unsupported URL" }],
    });
  url.hash = "";
  return url;
}

async function query(
  resolver: Resolver,
  type: DnsInput["type"],
  name: string,
): Promise<DnsRecord[]> {
  switch (type) {
    case "A":
      return (await resolver.resolve4(name, { ttl: true })).map((entry) => ({ type, ...entry }));
    case "AAAA":
      return (await resolver.resolve6(name, { ttl: true })).map((entry) => ({ type, ...entry }));
    case "CNAME":
      return (await resolver.resolveCname(name)).map((value) => ({ type, value }));
    case "NS":
      return (await resolver.resolveNs(name)).map((value) => ({ type, value }));
    case "PTR":
      return (isIP(name) ? await resolver.reverse(name) : await resolver.resolvePtr(name)).map(
        (value) => ({ type, value }),
      );
    case "MX":
      return (await resolver.resolveMx(name)).map((entry) => ({ type, ...entry }));
    case "TXT":
      return (await resolver.resolveTxt(name)).map((chunks) => ({ type, text: chunks.join("") }));
    case "SOA":
      return [{ type, ...(await resolver.resolveSoa(name)) }];
    case "CAA":
      return (await resolver.resolveCaa(name)).map((entry) => {
        const { critical, ...rest } = entry;
        const [tag = "", value = ""] = Object.entries(rest)[0] ?? [];
        return { type, critical, tag, value: String(value) };
      });
    case "SRV":
      return (await resolver.resolveSrv(name)).map((entry) => ({
        type,
        target: entry.name,
        port: entry.port,
        priority: entry.priority,
        weight: entry.weight,
      }));
  }
}

interface Exchange {
  status: number;
  location: string | null;
  result: Omit<NetHttpResponse, "url" | "redirects">;
}

/** One HTTP exchange with a pinned address; the response body is bounded after decompression. */
function exchange(
  url: URL,
  method: string,
  headers: HttpHeader[],
  body: Buffer | null,
  pinned: Pinned,
  verifyTls: boolean,
  signal: AbortSignal,
  context: { started: number; dns: number; appId: string },
): Promise<Exchange> {
  const has = (name: string) => headers.some(([key]) => key.toLowerCase() === name);
  // Raw headers keep the app's names and repeats; Node adds no Host to them.
  const raw: string[] = ["Host", url.host];
  for (const [name, value] of headers) raw.push(name, value);
  if (!has("user-agent")) raw.push("User-Agent", `EveryOS-App/1 (${context.appId})`);
  if (!has("accept")) raw.push("Accept", "*/*");
  if (!has("accept-encoding")) raw.push("Accept-Encoding", "gzip, deflate, br");
  if (body) raw.push("Content-Length", String(body.length));
  const at = () => Math.round(performance.now() - context.started);
  return new Promise<Exchange>((resolve, reject) => {
    let connect = 0;
    let tls: number | null = null;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        signal,
        agent: false,
        family: pinned.family,
        headers: raw,
        rejectUnauthorized: verifyTls,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      },
      (response: IncomingMessage) => {
        const firstByte = at();
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        const pairs: HttpHeader[] = [];
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2)
          pairs.push([response.rawHeaders[index]!, response.rawHeaders[index + 1]!]);
        const coding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
        const decoder =
          coding === "gzip" || coding === "x-gzip"
            ? createGunzip()
            : coding === "deflate"
              ? createInflate()
              : coding === "br"
                ? createBrotliDecompress()
                : null;
        const stream: Readable = decoder ? response.pipe(decoder) : response;
        const chunks: Buffer[] = [];
        let size = 0;
        let kept = 0;
        let truncated = false;
        const finish = () => {
          const bytes = Buffer.concat(chunks, kept);
          resolve({
            status,
            location,
            result: {
              status,
              statusText: response.statusMessage ?? "",
              httpVersion: response.httpVersion,
              headers: pairs,
              body: { ...bodyOf(bytes, response.headers["content-type"]), size, truncated },
              timing: { dns: Math.round(context.dns), connect, tls, firstByte, total: at() },
              remoteAddress: pinned.address,
            },
          });
        };
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          const room = NET_LIMITS.responseBodyBytes - kept;
          if (chunk.length > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            kept += Math.max(room, 0);
            truncated = true;
            response.destroy();
            decoder?.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          kept += chunk.length;
        });
        stream.once("end", () => {
          if (!truncated) finish();
        });
        stream.once("error", (error) => {
          if (!truncated) reject(error);
        });
      },
    );
    request.once("socket", (socket) => {
      socket.once("connect", () => {
        connect = at();
      });
      socket.once("secureConnect", () => {
        tls = at();
      });
    });
    request.once("error", reject);
    request.end(body ?? undefined);
  });
}
