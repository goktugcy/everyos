import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClientError, type Actor, type AgentConnectionState } from "@otuken/agent-protocol";
import { migrate, openDatabase, OTUKEN_MIGRATIONS, type Database } from "@otuken/database";
import { silentLogger } from "@otuken/logger";
import { CSRF_HEADER, type SessionInfo, type SystemInfo } from "@otuken/shared";
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

export class FakeAgent implements AgentGateway {
  state: AgentConnectionState = "connected";
  readonly calls: Array<{ op: string; actor: Actor }> = [];

  call: AgentGateway["call"] = (op, _params, actor) => {
    this.calls.push({ op, actor });
    if (this.state !== "connected") {
      return Promise.reject(new AgentClientError("AGENT_UNAVAILABLE", "not connected"));
    }
    if (op === "system.info") return Promise.resolve(sampleSystemInfo) as never;
    return Promise.resolve({
      pong: true,
      agentVersion: "test",
      uptimeSeconds: 1,
      mode: "development",
    }) as never;
  };
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
