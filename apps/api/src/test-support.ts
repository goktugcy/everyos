import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClientError, type Actor, type AgentConnectionState } from "@otuken/agent-protocol";
import { migrate, openDatabase, OTUKEN_MIGRATIONS, type Database } from "@otuken/database";
import { silentLogger } from "@otuken/logger";
import { createDockerSimulator, DockerError, type DockerApi } from "@otuken/system";
import {
  CSRF_HEADER,
  type LogEntry,
  type MetricsSample,
  type ServiceDetail,
  type ServiceList,
  type SessionInfo,
  type SystemInfo,
} from "@otuken/shared";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { loadApiConfig, type ApiConfig } from "./config.ts";
import type { AppEnv } from "./context.ts";
import { createServices, type AgentGateway, type Services } from "./services.ts";

export const TEST_HOST = "localhost:7470";
export const TEST_ORIGIN = `http://${TEST_HOST}`;
export const STRONG_PASSWORD = "mavi-gokyuzu-ve-daglar-42";

export const sampleSystemInfo: SystemInfo = {
  source: "host",
  hostname: "otuken-test",
  platform: "linux",
  arch: "arm64",
  kernel: "6.8.0",
  os: { id: "ubuntu", name: "Ubuntu", version: "24.04", prettyName: "Ubuntu 24.04 LTS" },
  cpu: { model: "ARM Cortex-A76", cores: 4 },
  memory: { totalBytes: 8 * 1024 ** 3 },
  uptimeSeconds: 10,
  bootTime: 0,
  hardware: { model: "Raspberry Pi 5 Model B Rev 1.0", isRaspberryPi: true },
  capabilities: {
    procfs: { available: true },
    systemd: { available: true },
    journald: { available: true },
    docker: { available: true },
    tailscale: { available: false, reason: "not-detected" },
    thermal: { available: true },
    raspberryPi: { available: true },
  },
  collectedAt: 0,
};

/** Raw counters that grow by a fixed amount per sample, so rates are predictable. */
export function sampleMetrics(index: number, at: number): MetricsSample {
  const cpu = (i: number) => ({
    user: 100 * i,
    nice: 0,
    system: 50 * i,
    idle: 250 * i,
    iowait: 50 * i,
    irq: 0,
    softirq: 0,
    steal: 0,
  });
  return {
    source: "host",
    at,
    uptimeSeconds: 1_000 + index,
    cpu: { total: cpu(index), cores: [cpu(index), cpu(index)] },
    memory: {
      totalBytes: 8_000_000_000,
      availableBytes: 6_000_000_000,
      freeBytes: 1_000_000_000,
      buffersBytes: 0,
      cachedBytes: 0,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    },
    load: [0.5, 0.4, 0.3],
    network: [
      {
        name: "lo",
        rxBytes: 1e6 * index,
        txBytes: 1e6 * index,
        rxPackets: 0,
        txPackets: 0,
        rxErrors: 0,
        txErrors: 0,
        physical: false,
      },
      {
        name: "br_kasm_sidecar",
        rxBytes: 5e5 * index,
        txBytes: 5e5 * index,
        rxPackets: 0,
        txPackets: 0,
        rxErrors: 0,
        txErrors: 0,
        physical: false,
      },
      {
        name: "eth0",
        rxBytes: 2_000 * index,
        txBytes: 1_000 * index,
        rxPackets: 0,
        txPackets: 0,
        rxErrors: 0,
        txErrors: 0,
        physical: true,
      },
    ],
    disks: [
      {
        name: "nvme0n1",
        readBytes: 4_096 * index,
        writeBytes: 8_192 * index,
        readOps: 0,
        writeOps: 0,
        busyMs: 100 * index,
      },
    ],
    thermal: [{ zone: "thermal_zone0", type: "cpu-thermal", celsius: 48.5 }],
    cpuFrequencyMHz: [2400, 2400],
    fans: null,
  };
}

export const sampleServices: ServiceList = {
  source: "host",
  units: [
    {
      name: "ssh.service",
      description: "OpenBSD Secure Shell server",
      load: "loaded",
      active: "active",
      sub: "running",
      unitFileState: "enabled",
      protected: true,
    },
    {
      name: "jellyfin.service",
      description: "Jellyfin",
      load: "loaded",
      active: "inactive",
      sub: "dead",
      unitFileState: "disabled",
      protected: false,
    },
  ],
};

export function sampleLogEntry(n: number): LogEntry {
  return {
    cursor: `s=1;i=${n}`,
    ts: 1_760_000_000_000 + n,
    priority: 6,
    unit: "ssh.service",
    identifier: "sshd",
    pid: 100,
    hostname: "otuken-test",
    message: `entry ${n}`,
  };
}

type FakeHandler = (params: unknown) => unknown;

/** Maps simulator errors to what the real agent client would report. */
function toAgentError(error: unknown): Error {
  if (!(error instanceof DockerError))
    return error instanceof Error ? error : new Error(String(error));
  const code =
    error.kind === "not-found"
      ? "not_found"
      : error.kind === "conflict"
        ? "conflict"
        : error.kind === "invalid"
          ? "invalid_params"
          : "failed";
  return new AgentClientError("AGENT_OPERATION_FAILED", error.message, code);
}

/**
 * In-memory agent for API tests. Every operation has a realistic default
 * answer; `handlers` overrides individual operations (throw to simulate an
 * agent error).
 */
export class FakeAgent implements AgentGateway {
  state: AgentConnectionState = "connected";
  readonly calls: Array<{ op: string; params: unknown; actor: Actor }> = [];
  readonly handlers = new Map<string, FakeHandler>();
  logEntries: LogEntry[] = [sampleLogEntry(1), sampleLogEntry(2)];
  #metricsIndex = 0;
  now: () => number = Date.now;

  #defaults(op: string, params: unknown): unknown {
    switch (op) {
      case "apps.inspect":
        return { source: "simulated", busy: false, ownership: "prepared", lastRun: null };
      case "system.info":
        return sampleSystemInfo;
      case "agent.ping":
        return { pong: true, agentVersion: "test", uptimeSeconds: 1, mode: "development" };
      case "metrics.sample":
        return sampleMetrics(++this.#metricsIndex, this.now());
      case "storage.usage":
        return {
          source: "host",
          mounts: [
            {
              device: "/dev/nvme0n1p2",
              mountpoint: "/",
              fsType: "ext4",
              readOnly: false,
              totalBytes: 500e9,
              usedBytes: 120e9,
              availableBytes: 355e9,
              inodesTotal: 1e6,
              inodesFree: 9e5,
            },
          ],
        };
      case "hardware.status":
        return {
          source: "host",
          throttling: { status: { available: true }, flags: null, raw: "0x0" },
          nvme: { status: { available: false, reason: "not-detected" }, devices: [] },
        };
      case "network.status":
        return {
          source: "host",
          interfaces: [],
          gateways: [],
          dns: [],
          internet: { state: "online", checkedAt: 1, latencyMs: 10 },
        };
      case "tailscale.status":
        return {
          status: { available: false, reason: "not-detected" },
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
      case "processes.list":
        return { source: "host", sampledAt: 1, total: 1, processes: [] };
      case "services.list":
        return sampleServices;
      case "services.get": {
        const unit = sampleServices.units.find((u) => u.name === (params as { unit: string }).unit);
        if (!unit)
          throw new AgentClientError("AGENT_OPERATION_FAILED", "Unit not found", "not_found");
        const detail: ServiceDetail = {
          ...unit,
          source: "host",
          mainPid: null,
          activeSince: null,
          memoryBytes: null,
          cpuNanoseconds: null,
          tasks: null,
          restarts: 0,
          fragmentPath: null,
          restartPolicy: null,
          type: "simple",
        };
        return detail;
      }
      case "services.control": {
        const { unit } = params as { unit: string };
        if (unit === "ssh.service") {
          throw new AgentClientError(
            "AGENT_OPERATION_DENIED",
            'PROTECTED_UNIT: ssh.service is protected; "stop" is not allowed from Otuken',
            "policy_denied",
          );
        }
        return { accepted: true };
      }
      case "logs.query":
        return { source: "host", entries: this.logEntries, hasMore: false };
      case "network.sockets":
        return {
          source: "host",
          listening: [
            { protocol: "tcp", address: "0.0.0.0", port: 22, process: "sshd" },
            { protocol: "tcp", address: "127.0.0.1", port: 7470, process: "node" },
          ],
          connections: { established: 3, timeWait: 1, other: 0 },
        };
      case "apt.updates":
        return {
          source: "host",
          listsUpdatedAt: 1_760_000_000_000,
          total: 2,
          security: 1,
          packages: [
            { name: "openssl", version: "3.0.13-0ubuntu3.6", security: true },
            { name: "curl", version: "8.5.0-2ubuntu10.7", security: false },
          ],
        };
      case "services.timers":
        return {
          source: "host",
          timers: [{ unit: "apt-daily.timer", activates: "apt-daily.service", next: 2, last: 1 }],
        };
      default:
        throw new Error(`FakeAgent: no default for ${op}`);
    }
  }

  /** Docker operations are answered by the development simulator, like a development agent. */
  #docker: DockerApi | null = null;
  get docker(): DockerApi {
    // Tests install their clock after constructing FakeAgent; start the simulator afterward.
    this.#docker ??= createDockerSimulator({
      now: () => this.now(),
      isProtected: (name) => name === "portainer",
    });
    return this.#docker;
  }

  #dockerCall(op: string, params: unknown): Promise<unknown> | null {
    const docker = this.docker;
    const p = params as Record<string, string>;
    const wrap = <T>(key: string, promise: Promise<T>) =>
      promise.then((value) => ({ source: docker.source, [key]: value }));
    switch (op) {
      case "docker.status":
        return docker.status();
      case "docker.containers.list":
        return wrap("containers", docker.listContainers());
      case "docker.containers.get":
        return docker.inspectContainer(p.id!, { showCommand: true });
      case "docker.containers.stats":
        return docker
          .listContainers()
          .then((list) => docker.stats(list.filter((c) => c.state === "running").map((c) => c.id)))
          .then((samples) => ({ source: docker.source, samples }));
      case "docker.containers.control":
        return docker.controlContainer(p.id!, p.action as "start").then(() => ({ accepted: true }));
      case "docker.images.list":
        return wrap("images", docker.listImages());
      case "docker.images.remove":
        return docker.removeImage(p.id!).then(() => ({ removed: true }));
      case "docker.volumes.list":
        return wrap("volumes", docker.listVolumes());
      case "docker.volumes.remove":
        return docker.removeVolume(p.name!).then(() => ({ removed: true }));
      case "docker.networks.list":
        return wrap("networks", docker.listNetworks());
      case "docker.networks.remove":
        return docker.removeNetwork(p.id!).then(() => ({ removed: true }));
      case "docker.compose.projects":
        return wrap("projects", docker.listProjects());
      case "docker.compose.check":
        return docker.checkProject(p.project!);
      case "apps.postgres.stats": {
        const stats = params as { container: string; user: string; database: string };
        return docker.postgresStats(stats.container, stats.user, stats.database);
      }
      case "docker.compose.run": {
        const run = params as {
          project: string;
          workingDir: string;
          configFiles: string[];
          action: "up";
        };
        return docker.runCompose(run.project, run.workingDir, run.configFiles, run.action);
      }
      default:
        return null;
    }
  }

  call: AgentGateway["call"] = (op, params, actor) => {
    this.calls.push({ op, params, actor });
    if (this.state !== "connected") {
      return Promise.reject(new AgentClientError("AGENT_UNAVAILABLE", "not connected"));
    }
    try {
      const handler = this.handlers.get(op);
      const result = handler
        ? handler(params)
        : (this.#dockerCall(op, params) ?? this.#defaults(op, params));
      return Promise.resolve(result).catch((error: unknown) => {
        throw toAgentError(error);
      }) as never;
    } catch (error) {
      return Promise.reject(toAgentError(error));
    }
  };

  /** Streams `logEntries`, then stays open until aborted (like `journalctl --follow`). */
  stream = async function* (
    this: FakeAgent,
    op: string,
    params: unknown,
    actor: Actor,
    options: { signal?: AbortSignal } = {},
  ) {
    this.calls.push({ op, params, actor });
    if (this.state !== "connected")
      throw new AgentClientError("AGENT_UNAVAILABLE", "not connected");
    const signal = options.signal ?? new AbortController().signal;
    if (op === "docker.containers.logs") {
      const { id, tail, follow } = params as { id: string; tail: number; follow: boolean };
      yield* this.docker.logs(id, { tail, follow }, signal);
      return;
    }
    if (op === "docker.events") {
      yield* this.docker.events(signal);
      return;
    }
    for (const entry of this.logEntries) yield entry;
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  } as unknown as AgentGateway["stream"];
}

export interface TestContext {
  app: Hono<AppEnv>;
  services: Services;
  db: Database;
  agent: FakeAgent;
  config: ApiConfig;
  clock: { now: number };
  dir: string;
  readSetupToken(): string;
}

export async function createTestContext(
  options: { configure?: (config: ApiConfig) => void; webDir?: string } = {},
): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), "otuken-api-"));
  const config = loadApiConfig({ OTUKEN_ENV: "development", OTUKEN_DEV_ROOT: dir });
  if (options.webDir) config.paths.webDir = options.webDir;
  options.configure?.(config);
  const db = openDatabase(config.paths.databaseFile);
  await migrate(db, OTUKEN_MIGRATIONS);
  const agent = new FakeAgent();
  const clock = { now: 1_760_000_000_000 };
  agent.now = () => clock.now;
  const services = createServices({
    config,
    logger: silentLogger,
    db,
    masterKey: Buffer.alloc(32, 5),
    agent,
    scryptParams: { log2N: 10, r: 8, p: 1 },
    now: () => clock.now,
  });
  services.setup.initialize();
  return {
    app: createApp(services),
    services,
    db,
    agent,
    config,
    clock,
    dir,
    readSetupToken: () => readFileSync(config.paths.setupTokenFile, "utf8").trim(),
  };
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string | Uint8Array;
  headers?: Record<string, string>;
  ip?: string;
  /** Omit the Origin header (non-browser client). */
  noOrigin?: boolean;
}

/**
 * Minimal browser-like client: keeps a cookie jar, sends Origin on unsafe
 * requests and attaches the CSRF token once a session is known.
 */
export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;
  readonly #ctx: TestContext;
  readonly #ip: string;

  constructor(ctx: TestContext, ip = "127.0.0.1") {
    this.#ctx = ctx;
    this.#ip = ip;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers({ host: TEST_HOST, ...options.headers });
    const unsafe = !["GET", "HEAD"].includes(method);
    if (unsafe && !options.noOrigin && !headers.has("origin")) headers.set("origin", TEST_ORIGIN);
    if (unsafe && this.csrfToken && !headers.has(CSRF_HEADER))
      headers.set(CSRF_HEADER, this.csrfToken);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    let body: string | Uint8Array | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
    const response = await this.#ctx.app.request(
      `http://${TEST_HOST}${path}`,
      { method, headers, ...(body !== undefined ? { body } : {}) },
      { incoming: { socket: { remoteAddress: options.ip ?? this.#ip, encrypted: false } } },
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, value] = pair!.split("=");
      if (!name) continue;
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value ?? "");
    }
    return response;
  }

  get(path: string, options?: RequestOptions) {
    return this.request("GET", path, options);
  }
  post(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request("POST", path, { ...options, ...(body !== undefined ? { body } : {}) });
  }
  patch(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request("PATCH", path, { ...options, ...(body !== undefined ? { body } : {}) });
  }
  delete(path: string, options?: RequestOptions) {
    return this.request("DELETE", path, options);
  }

  /** Adopts the CSRF token from a SessionInfo-bearing response. */
  adopt(session: SessionInfo): void {
    this.csrfToken = session.csrfToken;
  }

  async login(username: string, password: string): Promise<Response> {
    const response = await this.post("/api/auth/login", { username, password });
    if (response.ok) {
      const body = (await response.clone().json()) as { status: string; session?: SessionInfo };
      if (body.session) this.adopt(body.session);
    }
    return response;
  }
}

export async function completeSetup(
  ctx: TestContext,
  client: TestClient,
  username = "admin",
): Promise<SessionInfo> {
  const response = await client.post("/api/setup", {
    setupToken: ctx.readSetupToken(),
    username,
    displayName: "Yönetici",
    password: STRONG_PASSWORD,
    locale: "tr",
  });
  if (response.status !== 201)
    throw new Error(`setup failed: ${response.status} ${await response.text()}`);
  const session = (await response.json()) as SessionInfo;
  client.adopt(session);
  return session;
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** A completed setup plus signed-in operator and viewer clients. */
export async function withRoles() {
  const ctx = await createTestContext();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  const users: Record<"operator" | "viewer", TestClient> = {} as never;
  for (const role of ["operator", "viewer"] as const) {
    await admin.post("/api/users", {
      username: role,
      displayName: role,
      password: STRONG_PASSWORD,
      role,
    });
    const client = new TestClient(ctx, role === "operator" ? "192.0.2.10" : "192.0.2.11");
    const login = await client.login(role, STRONG_PASSWORD);
    if (login.status !== 200) throw new Error(`login as ${role} failed: ${login.status}`);
    users[role] = client;
  }
  return { ctx, admin, ...users };
}

/** Reads server-sent events until `count` events (other than comments) arrived. */
export async function readEvents(response: Response, count: number, timeoutMs = 2_000) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: unknown }> = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.max(1, deadline - Date.now()),
        ),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) events.push({ event, data: data ? (JSON.parse(data) as unknown) : null });
      index = buffer.indexOf("\n\n");
    }
  }
  return { events, reader };
}

export async function streamEnds(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk === null) return false;
    if (chunk.done) return true;
  }
  return false;
}
