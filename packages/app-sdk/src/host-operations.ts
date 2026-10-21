/*
 * Server operations an app reaches through `host.call`: each maps to one `/api/app-sdk/host/*`
 * route and one capability, checked on the server for every call (docs/app-sdk/permissions.md).
 */

export const HOST_OPERATIONS = [
  "system.metrics",
  "system.info",
  "system.sockets",
  "system.network",
  "logs.query",
  "disk.usage",
  "net.http",
  "net.dns",
  "net.tls",
  "net.monitors.list",
  "net.monitors.history",
  "net.monitors.save",
  "net.monitors.delete",
  "net.monitors.check",
  "db.connections",
  "db.test",
  "db.tables",
  "db.query",
  "ssh.keys.list",
  "ssh.keys.generate",
  "ssh.keys.import",
  "ssh.keys.export",
  "ssh.keys.delete",
  "appearance.wallpapers",
  "appearance.setWallpaper",
  "appearance.uploadWallpaper",
  "appearance.folderIcons",
  "appearance.uploadFolderIcon",
] as const;
export type HostOperation = (typeof HOST_OPERATIONS)[number];

/* ------------------------------------------------------------------ network (network:outbound) */

/**
 * Bounds of the network operations. Every target (each redirect hop, each monitor check) must be
 * allowed by the administrator's network policy; EveryOS credentials are never sent.
 */
export const NET_LIMITS = {
  /** Request body, after decoding (text as UTF-8, or base64 bytes). */
  requestBodyBytes: 192 * 1024,
  /** Response body kept, after decompression; the rest is cut (`truncated`). */
  responseBodyBytes: 2 * 1024 * 1024,
  headers: 64,
  headerBytes: 32 * 1024,
  redirects: 5,
  timeoutMs: { min: 1000, max: 60_000, default: 30_000 },
  monitors: 50,
  monitorIntervalSeconds: { min: 60, max: 86_400 },
} as const;

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** One header as sent or received: names keep their case and repeated headers stay separate. */
export type HttpHeader = [name: string, value: string];

export interface NetHttpRequest {
  method: HttpMethod;
  /** An `http:` or `https:` URL without credentials. */
  url: string;
  headers?: HttpHeader[];
  /** Text (sent as UTF-8) or bytes in base64. */
  body?: { text: string } | { base64: string } | null;
  /** Follows up to five redirects, each checked against the network policy. Default: false. */
  followRedirects?: boolean;
  /** Refuse certificates the server's trusted roots do not verify. Default: true. */
  verifyTls?: boolean;
  timeoutMs?: number;
}

export interface NetHttpResponse {
  /** The URL that answered (after redirects). */
  url: string;
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HttpHeader[];
  body: {
    /** Text when the response is textual and valid in its charset; otherwise base64. */
    encoding: "text" | "base64";
    data: string;
    /** Bytes received (after decompression); at least this many when `truncated`. */
    size: number;
    truncated: boolean;
  };
  /** Milliseconds from the start of the last hop: each value is when that phase ended. */
  timing: { dns: number; connect: number; tls: number | null; firstByte: number; total: number };
  remoteAddress: string;
  redirects: Array<{ url: string; status: number }>;
}

/**
 * Why a network operation failed (`error.details.reason`, with code
 * `DESKTOP_APP_NETWORK_FAILED`); `DESKTOP_APP_NETWORK_BLOCKED` means the policy refused the target.
 */
export type NetFailure =
  | "dns"
  | "refused"
  | "unreachable"
  | "timeout"
  | "reset"
  | "tls"
  | "too-many-redirects"
  | "invalid-response"
  | "error";

export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "TXT",
  "SOA",
  "CAA",
  "SRV",
  "PTR",
] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface NetDnsQuery {
  /** A host name (`_service._tcp` labels allowed), or an IP address for `PTR`. */
  name: string;
  type: DnsRecordType;
  /** A DNS server's IP address: a network target on port 53. Default: the server's resolvers. */
  server?: string | null;
  /** The DNS server's port (default 53). */
  serverPort?: number;
  timeoutMs?: number;
}

export type DnsRecord =
  | { type: "A" | "AAAA"; address: string; ttl: number }
  | { type: "CNAME" | "NS" | "PTR"; value: string }
  | { type: "MX"; exchange: string; priority: number }
  | { type: "TXT"; text: string }
  | {
      type: "SOA";
      nsname: string;
      hostmaster: string;
      serial: number;
      refresh: number;
      retry: number;
      expire: number;
      minttl: number;
    }
  | { type: "CAA"; critical: number; tag: string; value: string }
  | { type: "SRV"; target: string; port: number; priority: number; weight: number };

export interface NetDnsResult {
  name: string;
  type: DnsRecordType;
  /** The servers asked. */
  servers: string[];
  status: "ok" | "no-data" | "not-found" | "refused" | "server-failure" | "timeout" | "error";
  ms: number;
  records: DnsRecord[];
}

export interface NetTlsTarget {
  host: string;
  /** Default 443. */
  port?: number;
  /** The name sent in SNI and checked against the certificate. Default: `host` (none for IPs). */
  servername?: string | null;
  timeoutMs?: number;
}

export interface TlsCertificate {
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  validFrom: number;
  validTo: number;
  serialNumber: string;
  fingerprint256: string;
  keyType: string | null;
  keyBits: number | null;
  selfSigned: boolean;
}

export interface NetTlsResult {
  host: string;
  port: number;
  remoteAddress: string;
  protocol: string | null;
  cipher: { name: string; standardName: string; version: string } | null;
  alpn: string | null;
  /** The chain verifies against the server's trusted roots. */
  authorized: boolean;
  authorizationError: string | null;
  /** The leaf certificate is valid for `servername`. */
  hostnameMatches: boolean;
  /** Leaf first. */
  chain: TlsCertificate[];
  ms: number;
}

/** An HTTP check EveryOS runs on its own schedule, also while the app is closed. */
export interface NetMonitorInput {
  /** Omit to create a monitor. */
  id?: string | null;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutMs: number;
  /** Status codes counted as up, inclusive. */
  expectStatus: { min: number; max: number };
  /** Text the body must contain (GET only). */
  keyword?: string | null;
  /** Failed checks in a row before the monitor is down (1–5). */
  downAfter: number;
  /** Count certificates the server's trusted roots do not verify as failures. */
  verifyTls: boolean;
  /** Notify the person when it goes down or comes back (needs notifications:send). */
  notify: boolean;
  enabled: boolean;
}

/**
 * `blocked`: the network policy no longer allows the target; `paused`: turned off, or the app
 * lost network:outbound.
 */
export type NetMonitorState = "pending" | "up" | "down" | "blocked" | "paused";

export interface NetMonitor extends Required<Omit<NetMonitorInput, "id">> {
  id: string;
  keyword: string | null;
  state: NetMonitorState;
  stateSince: number | null;
  checkedAt: number | null;
  lastStatus: number | null;
  lastMs: number | null;
  /** `status`, `keyword`, `blocked` or a NetFailure. */
  lastError: string | null;
  /** Share of successful checks (0–1); null without checks in the period. */
  uptime24h: number | null;
  uptime7d: number | null;
  avgMs24h: number | null;
  createdAt: number;
}

export interface NetMonitorCheck {
  at: number;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
}

/* ------------------------------------------------------------------ databases (database:connect) */

/**
 * Databases an administrator connected in EveryOS. The app never sees credentials: it names a
 * connection, and EveryOS connects. Queries run read-only unless the connection allows writing and
 * the person confirms the statement in a dialog EveryOS draws.
 */
export const DB_LIMITS = {
  sqlChars: 100_000,
  params: 100,
  rows: { max: 1000, default: 500 },
  /** Longer text values are cut (ending with "…"). */
  cellChars: 65_536,
  /** The result is cut (`truncated`) once it grows past this, in JSON. */
  resultBytes: 4 * 1024 * 1024,
  timeoutMs: { min: 1000, max: 120_000, default: 30_000 },
} as const;

export type DbEngine = "postgres" | "mysql";

export interface DbConnection {
  id: string;
  name: string;
  /** `mysql` also covers MariaDB. */
  engine: DbEngine;
  host: string;
  port: number;
  database: string;
  /** `read`: every statement runs in a read-only transaction. */
  access: "read" | "write";
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface DbTable {
  schema: string | null;
  name: string;
  kind: "table" | "view";
  columns: DbColumn[];
}

export type DbParam = string | number | boolean | null;

export interface DbQueryInput {
  connection: string;
  /** One statement; parameters as `$1` (PostgreSQL) or `?` (MySQL). */
  sql: string;
  params?: DbParam[];
  maxRows?: number;
  timeoutMs?: number;
  /** Asks to change data: needs a writable connection and the person's confirmation. */
  write?: boolean;
}

export interface DbQueryResult {
  /** `SELECT`, `INSERT`, … when the database says. */
  command: string | null;
  columns: Array<{ name: string; type: string }>;
  /**
   * One array per row. Values are JSON: numbers, text (big numbers, dates and times as text),
   * booleans, null, JSON values; binary data as `\x` and hex.
   */
  rows: unknown[][];
  /** Rows returned or changed, when the database says. */
  rowCount: number | null;
  truncated: boolean;
  ms: number;
  readOnly: boolean;
}

/* ------------------------------------------------------------------ typed operations */

/** Input and result of each operation (unknown where the app reads EveryOS's own shapes). */
export interface HostOperations {
  "system.metrics": { input: null; result: unknown };
  "system.info": { input: null; result: unknown };
  "system.sockets": { input: null; result: unknown };
  "system.network": { input: null; result: unknown };
  "logs.query": { input: unknown; result: unknown };
  "disk.usage": { input: { handle: string; path?: string }; result: unknown };
  "net.http": { input: NetHttpRequest; result: NetHttpResponse };
  "net.dns": { input: NetDnsQuery; result: NetDnsResult };
  "net.tls": { input: NetTlsTarget; result: NetTlsResult };
  "net.monitors.list": { input: null; result: { monitors: NetMonitor[] } };
  "net.monitors.history": {
    input: { id: string; since?: number; limit?: number };
    result: { checks: NetMonitorCheck[] };
  };
  "net.monitors.save": { input: NetMonitorInput; result: NetMonitor };
  "net.monitors.delete": { input: { id: string }; result: null };
  /** Checks now (at most once every 10 seconds per monitor). */
  "net.monitors.check": { input: { id: string }; result: NetMonitor };
  "db.connections": { input: null; result: { connections: DbConnection[] } };
  /** Connects and asks the server's version. */
  "db.test": { input: { connection: string }; result: { version: string; ms: number } };
  "db.tables": { input: { connection: string }; result: { tables: DbTable[]; truncated: boolean } };
  "db.query": { input: DbQueryInput; result: DbQueryResult };
  "ssh.keys.list": { input: unknown; result: unknown };
  "ssh.keys.generate": { input: unknown; result: unknown };
  "ssh.keys.import": { input: unknown; result: unknown };
  "ssh.keys.export": { input: unknown; result: unknown };
  "ssh.keys.delete": { input: unknown; result: unknown };
  "appearance.wallpapers": { input: unknown; result: unknown };
  "appearance.setWallpaper": { input: unknown; result: unknown };
  "appearance.uploadWallpaper": { input: unknown; result: unknown };
  "appearance.folderIcons": { input: unknown; result: unknown };
  "appearance.uploadFolderIcon": { input: unknown; result: unknown };
}

export type HostInput<O extends HostOperation> = HostOperations[O]["input"];
export type HostResult<O extends HostOperation> = HostOperations[O]["result"];
