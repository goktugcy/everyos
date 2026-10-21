/*
 * Server operations an app reaches through `host.call`: each maps to one `/api/app-sdk/host/*`
 * route and one capability, checked on the server for every call (docs/app-sdk/permissions.md).
 */

export const HOST_OPERATIONS = [
  "system.metrics",
  "system.info",
  "system.sockets",
  "system.network",
  "system.storage",
  "system.services",
  "logs.query",
  "disk.usage",
  "integration.list",
  "integration.data",
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
  "ssh.keys.update",
  "ssh.keys.export",
  "ssh.keys.delete",
] as const;
export type HostOperation = (typeof HOST_OPERATIONS)[number];

/** The capability each operation needs (the server checks it, with the person's role, every call). */
export const HOST_OPERATION_CAPABILITY: Readonly<Record<HostOperation, string>> = {
  "system.metrics": "system:metrics.read",
  "system.info": "system:metrics.read",
  "system.sockets": "system:sockets.read",
  "system.network": "system:network.read",
  "system.storage": "system:metrics.read",
  "system.services": "system:services.read",
  "logs.query": "logs:read",
  "disk.usage": "storage:usage.read",
  // Any `integration:<adapter>` the app holds; the server checks each integration's adapter.
  "integration.list": "integration:*",
  "integration.data": "integration:*",
  "net.http": "network:outbound",
  "net.dns": "network:outbound",
  "net.tls": "network:outbound",
  "net.monitors.list": "network:outbound",
  "net.monitors.history": "network:outbound",
  "net.monitors.save": "network:outbound",
  "net.monitors.delete": "network:outbound",
  "net.monitors.check": "network:outbound",
  "db.connections": "database:connect",
  "db.test": "database:connect",
  "db.tables": "database:connect",
  "db.query": "database:connect",
  "ssh.keys.list": "secrets:ssh",
  "ssh.keys.generate": "secrets:ssh",
  "ssh.keys.import": "secrets:ssh",
  "ssh.keys.update": "secrets:ssh",
  "ssh.keys.export": "secrets:ssh",
  "ssh.keys.delete": "secrets:ssh",
};

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

/* ------------------------------------------------------------------ SSH keys (secrets:ssh) */

/**
 * The person's own SSH keys, kept by EveryOS. Private keys are sealed on the server; exporting one,
 * or deleting a key that has one, needs the person's confirmation in a dialog EveryOS draws.
 */
export const SSH_KEY_TYPES = [
  "ed25519",
  "ecdsa-256",
  "ecdsa-384",
  "ecdsa-521",
  "rsa-3072",
  "rsa-4096",
] as const;
export type SshKeyType = (typeof SSH_KEY_TYPES)[number];

export interface SshKey {
  id: string;
  name: string;
  /** The OpenSSH key type: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, `sk-…` … */
  type: string;
  bits: number;
  comment: string;
  /** `SHA256:` and the unpadded base64 digest, as `ssh-keygen -l` prints it. */
  fingerprint: string;
  /** One `authorized_keys` line. */
  publicKey: string;
  /** False for imported public keys. */
  hasPrivateKey: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ hybrid apps (integration:<adapter>) */

/**
 * An EveryOS integration (configured by an administrator: a Docker app or a service elsewhere) of
 * an adapter the app declares. Apps read its data feeds, never its address or credentials.
 */
export interface IntegrationInfo {
  id: string;
  name: string;
  adapter: string;
  /** Data feeds the adapter provides (the same ones built-in widgets show). */
  feeds: string[];
}

export type IntegrationData =
  | { status: "ok"; data: unknown; at: number }
  | { status: "unavailable"; reason: string; at: number }
  | { status: "error"; code: string; at: number };

/* ------------------------------------------------------------------ system (read-only) */

/**
 * Where a figure comes from: the machine EveryOS runs on, or (development installations only)
 * EveryOS's simulator. Apps show simulated data as such.
 */
export type SystemDataSource = "host" | "simulated";

export interface SystemMetricsPoint {
  at: number;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  load1: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
  temperatureC: number | null;
}

/** The latest measurement (null: not measurable on this machine). */
export interface SystemMetrics {
  source: SystemDataSource;
  point: SystemMetricsPoint;
  uptimeSeconds: number;
  load: [number, number, number] | null;
  cpuCores: number[] | null;
  cpuFrequencyMHz: number[] | null;
  interfaces: Array<{ name: string; rxBytesPerSec: number; txBytesPerSec: number }> | null;
  disks: Array<{
    name: string;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    busyPercent: number;
  }> | null;
  thermal: Array<{ zone: string; type: string; celsius: number }> | null;
  fans: Array<{ name: string; rpm: number }> | null;
}

/** What EveryOS can read on this machine, and why not when it cannot. */
export interface SystemCapabilityStatus {
  available: boolean;
  reason?:
    | "not-linux"
    | "not-detected"
    | "socket-missing"
    | "permission-denied"
    | "unsupported-hardware"
    | "tool-missing"
    | undefined;
  simulated?: true | undefined;
}

export interface SystemInfo {
  source: SystemDataSource;
  hostname: string;
  platform: string;
  arch: string;
  kernel: string;
  os: { id: string | null; name: string; version: string | null; prettyName: string };
  cpu: { model: string; cores: number };
  memory: { totalBytes: number };
  uptimeSeconds: number;
  /** Milliseconds since the epoch. */
  bootTime: number;
  hardware: { model: string | null; isRaspberryPi: boolean };
  capabilities: Record<
    "procfs" | "systemd" | "journald" | "docker" | "tailscale" | "thermal" | "raspberryPi",
    SystemCapabilityStatus
  >;
  collectedAt: number;
}

export interface SystemSockets {
  source: SystemDataSource;
  /** At most 2,000 listening sockets. */
  listening: Array<{
    protocol: "tcp" | "udp";
    address: string;
    port: number;
    /** The program, when EveryOS may see it. */
    process: string | null;
  }>;
  connections: { established: number; timeWait: number; other: number };
}

export interface SystemNetwork {
  source: SystemDataSource;
  interfaces: Array<{
    name: string;
    kind: "ethernet" | "wireless" | "loopback" | "tailscale" | "bridge" | "virtual" | "other";
    up: boolean;
    mac: string | null;
    mtu: number | null;
    speedMbps: number | null;
    addresses: Array<{ family: "ipv4" | "ipv6"; address: string; prefix: number }>;
  }>;
  gateways: Array<{ interface: string; address: string; family: "ipv4" | "ipv6" }>;
  dns: string[];
  internet: {
    state: "online" | "offline" | "unknown" | "disabled";
    checkedAt: number | null;
    latencyMs: number | null;
  };
}

/** Mounted file systems and how full they are. */
export interface SystemStorage {
  source: SystemDataSource;
  mounts: Array<{
    device: string;
    mountpoint: string;
    fsType: string;
    readOnly: boolean;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    inodesTotal: number;
    inodesFree: number;
  }>;
}

/** systemd services (read-only: apps never start or stop them). */
export interface SystemServices {
  source: SystemDataSource;
  units: Array<{
    name: string;
    description: string;
    /** `loaded`, `not-found` … */
    load: string;
    /** `active`, `inactive`, `failed`, `activating` … */
    active: string;
    /** `running`, `exited`, `dead` … */
    sub: string;
    unitFileState: string | null;
    protected: boolean;
  }>;
}

/** A journal query: newest first, `before` continues towards older entries. */
export interface LogQuery {
  unit?: string;
  /** This priority and everything more severe: 0 emerg … 3 err, 4 warning … 7 debug. */
  priority?: number;
  since?: number;
  until?: number;
  /** Text the message contains. */
  grep?: string;
  /** 1–1,000 (default 200). */
  limit?: number;
  before?: string;
}

export interface LogEntry {
  cursor: string;
  ts: number;
  priority: number;
  unit: string | null;
  identifier: string | null;
  pid: number | null;
  hostname: string | null;
  message: string;
}

export interface LogPage {
  source: SystemDataSource;
  entries: LogEntry[];
  hasMore: boolean;
}

/** Sizes inside a folder the person shared with the app (bounded in entries, depth and time). */
export interface DiskUsage {
  total: number;
  files: number;
  folders: number;
  /** Not every entry was measured (limits reached, or folders that could not be read). */
  truncated: boolean;
  children: Array<{ name: string; kind: "file" | "directory"; size: number; items: number }>;
  largest: Array<{ path: string; size: number }>;
  types: Array<{ extension: string; count: number; size: number }>;
}

/* ------------------------------------------------------------------ typed operations */

/** Input and result of each operation. */
export interface HostOperations {
  "system.metrics": { input: null; result: SystemMetrics };
  "system.info": { input: null; result: SystemInfo };
  "system.sockets": { input: null; result: SystemSockets };
  "system.network": { input: null; result: SystemNetwork };
  "system.storage": { input: null; result: SystemStorage };
  "system.services": { input: null; result: SystemServices };
  "logs.query": { input: LogQuery; result: LogPage };
  /** `handle`: a folder the person shared with the app (`files.open({ directory: true })`). */
  "disk.usage": { input: { handle: string; path?: string }; result: DiskUsage };
  "integration.list": { input: null; result: { integrations: IntegrationInfo[] } };
  "integration.data": { input: { integration: string; feed: string }; result: IntegrationData };
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
  "ssh.keys.list": { input: null; result: { keys: SshKey[] } };
  "ssh.keys.generate": {
    input: { name: string; type: SshKeyType; comment: string };
    result: SshKey;
  };
  /** A public key (one `authorized_keys` line). */
  "ssh.keys.import": { input: { name: string; publicKey: string }; result: SshKey };
  "ssh.keys.update": { input: { id: string; name: string; comment: string }; result: SshKey };
  /**
   * The public key, or (`private: true`, after the person confirms) the private key in OpenSSH
   * format, encrypted with `passphrase` when given.
   */
  "ssh.keys.export": {
    input: { id: string; private: boolean; passphrase?: string | null };
    result: { text: string; fileName: string };
  };
  "ssh.keys.delete": { input: { id: string }; result: null };
}

export type HostInput<O extends HostOperation> = HostOperations[O]["input"];
export type HostResult<O extends HostOperation> = HostOperations[O]["result"];
