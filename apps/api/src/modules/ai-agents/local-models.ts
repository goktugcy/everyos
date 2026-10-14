import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { AgentClientError, type Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import {
  AI_AGENT_CATALOG_ID,
  EVERYOS_OLLAMA_NETWORK_URL,
  OLLAMA_ACCELERATIONS,
  type AppJobView,
  type EveryosOllamaView,
  type InstalledAppView,
  type LocalModel,
  type LocalModelPull,
  type LocalModelServer,
  type LocalModelsView,
  type LocalServerKind,
  type OllamaAcceleration,
} from "@everyos/shared";
import { z } from "zod";
import { ApiError } from "../../http/errors.ts";
import type { AgentGateway } from "../../services.ts";
import type { AppService } from "../apps/app-service.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  IntegrationHttpError,
  joinUrl,
  requestJson,
  type HttpOptions,
} from "../integrations/http.ts";
import { HOST_GATEWAY, OLLAMA_PORT, ollamaTemplate } from "./templates.ts";

/** Default loopback ports of common local model servers. Nothing else is probed blindly. */
export const LOCAL_SERVER_PORTS: ReadonlyArray<readonly [number, LocalServerKind]> = [
  [OLLAMA_PORT, "ollama"],
  [1234, "lmstudio"],
  [8080, "llamacpp"],
  [8000, "vllm"],
];
/** Processes whose listening ports are also probed, for servers on non-default ports. */
const SERVER_PROCESSES: ReadonlyArray<readonly [RegExp, LocalServerKind]> = [
  [/^ollama/i, "ollama"],
  [/^(lms|lm[ -]?studio)/i, "lmstudio"],
  [/^llama[-_]?server/i, "llamacpp"],
  [/^vllm/i, "vllm"],
  [/^local-?ai/i, "localai"],
];
/** Official images and the port each serves inside its container. */
const SERVER_IMAGES: ReadonlyArray<readonly [RegExp, LocalServerKind, number]> = [
  [/(?:^|\/)ollama\/ollama(?::|@|$)/, "ollama", OLLAMA_PORT],
  [/(?:^|\/)(?:ggml-org|ggerganov)\/llama\.cpp(?::|@|$)/, "llamacpp", 8080],
  [/(?:^|\/)vllm\/vllm-openai(?::|@|$)/, "vllm", 8000],
  [/(?:^|\/)(?:localai\/localai|go-skynet\/local-ai)(?::|@|$)/, "localai", 8080],
];
const SERVER_NAMES: Record<LocalServerKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  localai: "LocalAI",
  openai: "OpenAI-compatible server",
};
const ACCELERATION_KEY = "ai.ollama.acceleration";
const HOST_FACTS_TTL_MS = 60_000;
const AccelerationSetting = z.object({
  current: z.enum(OLLAMA_ACCELERATIONS).optional(),
  pending: z
    .object({ job: z.string().max(64), acceleration: z.enum(OLLAMA_ACCELERATIONS) })
    .optional(),
});
const MAX_PULLS = 2;
const PULL_RETENTION_MS = 10 * 60_000;

const OllamaVersion = z.object({ version: z.string().max(64) });
const OllamaTags = z.object({
  models: z
    .array(
      z.object({
        name: z.string().max(200),
        size: z.number().nonnegative().optional(),
        details: z
          .object({
            family: z.string().max(64).nullish(),
            parameter_size: z.string().max(32).nullish(),
            quantization_level: z.string().max(32).nullish(),
          })
          .nullish(),
      }),
    )
    .max(500)
    .nullish(),
});
const OpenAiModels = z.object({
  data: z
    .array(z.object({ id: z.string().max(200), owned_by: z.string().max(100).nullish() }))
    .max(500),
});
const PullLine = z.object({
  status: z.string().max(200).optional(),
  total: z.number().nonnegative().optional(),
  completed: z.number().nonnegative().optional(),
  error: z.string().max(2000).optional(),
});

interface Candidate {
  id: string;
  source: LocalModelServer["source"];
  name: string;
  port: number;
  hint: LocalServerKind;
  containerUrl: string | null;
  containerAccess: LocalModelServer["containerAccess"];
  /** Known installations are listed even when they do not answer. */
  keep: boolean;
}
type HostFacts = Pick<EveryosOllamaView, "hardware" | "memoryBytes" | "unavailable">;
interface Pull {
  view: LocalModelPull;
  controller: AbortController;
}

const loopbackAddress = (address: string) =>
  /^127\./.test(address) || address === "::1" || address === "localhost";
const wildcardAddress = (address: string) => ["0.0.0.0", "::", "*", "[::]", ""].includes(address);

/**
 * Local model servers on the EveryOS host and the system-wide EveryOS Ollama. Servers are named
 * by discovered id; actions never take a caller-supplied URL, and every address is loopback.
 */
export class LocalModelService {
  readonly #db: Database;
  readonly #apps: AppService;
  readonly #agent: AgentGateway;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #resolve: HttpOptions["resolve"];
  readonly #ports: ReadonlyArray<readonly [number, LocalServerKind]>;
  readonly #pulls = new Map<string, Pull>();
  #host: { at: number; value: Promise<HostFacts> } | null = null;
  /** Hosts without a socket list (non-Linux development) are not asked again. */
  #socketsUnsupported = false;
  #settingUp = false;
  constructor(deps: {
    db: Database;
    apps: AppService;
    agent: AgentGateway;
    audit: AuditLog;
    now: () => number;
    resolve?: HttpOptions["resolve"];
    /** Test hook; production probes {@link LOCAL_SERVER_PORTS}. */
    ports?: ReadonlyArray<readonly [number, LocalServerKind]>;
  }) {
    this.#db = deps.db;
    this.#apps = deps.apps;
    this.#agent = deps.agent;
    this.#audit = deps.audit;
    this.#now = deps.now;
    this.#resolve = deps.resolve;
    this.#ports = deps.ports ?? LOCAL_SERVER_PORTS;
  }
  stop(): void {
    for (const pull of this.#pulls.values()) pull.controller.abort();
  }

  /* ----------------------------- EveryOS Ollama ----------------------------- */

  async ollamaApp(actor: Actor): Promise<InstalledAppView | null> {
    return (
      (await this.#apps.list(actor)).find(
        (app) =>
          app.provenance.catalogId === AI_AGENT_CATALOG_ID && app.provenance.path === "ollama",
      ) ?? null
    );
  }
  /** Base URL of the running EveryOS Ollama, for the EveryOS host. */
  async ollamaBase(actor: Actor): Promise<string> {
    const app = await this.ollamaApp(actor);
    if (!app) throw new ApiError(409, "CONFLICT", "The EveryOS Ollama is not installed");
    if (app.source === "simulated" || app.state !== "running" || app.lastError)
      throw new ApiError(409, "CONFLICT", "The EveryOS Ollama is not ready");
    const port = app.ports.find((entry) => entry.hostIp === "127.0.0.1");
    if (!port) throw new ApiError(409, "CONFLICT", "The EveryOS Ollama port is not available");
    return `http://127.0.0.1:${port.port}`;
  }
  /**
   * The deployed acceleration. A requested change stays pending with its job and only becomes
   * current once that job succeeds, so a failed GPU change never shows as applied.
   */
  #acceleration(): OllamaAcceleration {
    const raw = this.#db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      ACCELERATION_KEY,
    )?.value;
    const parsed = AccelerationSetting.safeParse(raw ? JSON.parse(raw) : {});
    const setting = parsed.success ? parsed.data : {};
    if (setting.pending) {
      const stage = this.#apps.job(setting.pending.job)?.stage;
      if (stage === "succeeded" || stage === "failed" || stage === undefined) {
        const settled = {
          current: stage === "succeeded" ? setting.pending.acceleration : setting.current,
        };
        this.#writeAcceleration(settled);
        return settled.current ?? "cpu";
      }
    }
    return setting.current ?? "cpu";
  }
  #writeAcceleration(setting: z.infer<typeof AccelerationSetting>) {
    this.#db.run(
      `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ACCELERATION_KEY,
      JSON.stringify(setting),
      this.#now(),
    );
  }
  /** Docker and host facts change rarely; `docker.status` also starts a Compose process. */
  #hostFacts(actor: Actor, fresh = false): Promise<HostFacts> {
    if (fresh || !this.#host || this.#now() - this.#host.at > HOST_FACTS_TTL_MS) {
      const value = Promise.allSettled([
        this.#agent.call("docker.status", {}, actor),
        this.#agent.call("system.info", {}, actor),
      ]).then(([docker, system]): HostFacts => {
        const status = docker.status === "fulfilled" ? docker.value : null;
        const arch = system.status === "fulfilled" ? system.value.arch : null;
        return {
          hardware: {
            nvidia: status?.gpu?.nvidia ?? false,
            amd: (status?.gpu?.amd ?? false) && (arch === "x64" || arch === "amd64"),
          },
          memoryBytes: system.status === "fulfilled" ? system.value.memory.totalBytes : null,
          unavailable: !status?.status.available
            ? "docker"
            : !status.compose.available
              ? "compose"
              : arch && !["x64", "amd64", "arm64", "aarch64"].includes(arch)
                ? "architecture"
                : null,
        };
      });
      this.#host = { at: this.#now(), value };
    }
    return this.#host.value;
  }
  async ollama(
    actor: Actor,
    app?: InstalledAppView | null,
    fresh = false,
  ): Promise<EveryosOllamaView> {
    const [installed, facts] = await Promise.all([
      app === undefined ? this.ollamaApp(actor) : Promise.resolve(app),
      this.#hostFacts(actor, fresh),
    ]);
    return { app: installed, acceleration: this.#acceleration(), ...facts };
  }
  /** Installs the EveryOS Ollama, or changes the acceleration of the installed one. */
  async setupOllama(acceleration: OllamaAcceleration, actor: Actor): Promise<AppJobView> {
    // Two concurrent requests must not install two Ollamas under the same network alias.
    if (this.#settingUp) throw new ApiError(409, "CONFLICT", "Ollama setup in progress");
    this.#settingUp = true;
    try {
      return await this.#setup(acceleration, actor);
    } finally {
      this.#settingUp = false;
    }
  }
  async #setup(acceleration: OllamaAcceleration, actor: Actor): Promise<AppJobView> {
    const app = await this.ollamaApp(actor).catch(() => null);
    const view = await this.ollama(actor, app, true);
    if (view.unavailable && !app)
      throw new ApiError(409, "CONFLICT", "Docker and Compose v2 are required", {
        details: { reason: view.unavailable },
      });
    if (
      (acceleration === "nvidia" && !view.hardware.nvidia) ||
      (acceleration === "amd" && !view.hardware.amd)
    )
      throw new ApiError(409, "CONFLICT", "This GPU is not available to Docker on this host", {
        details: { reason: `gpu-${acceleration}` },
      });
    const template = ollamaTemplate(acceleration);
    const job = app
      ? await this.#apps.configureBuiltin(
          app.id,
          template,
          actor,
          acceleration === "cpu" ? [] : ["devices"],
        )
      : await this.#apps.installBuiltin(template, actor);
    this.#writeAcceleration({
      current: app ? this.#acceleration() : undefined,
      pending: { job: job.id, acceleration },
    });
    this.#event(app ? "ollama-configure" : "ollama-install", actor, "success", { acceleration });
    return job;
  }
  async controlOllama(
    action: "start" | "stop" | "restart" | "retry",
    actor: Actor,
  ): Promise<AppJobView> {
    const app = await this.ollamaApp(actor);
    if (!app) throw new ApiError(409, "CONFLICT", "The EveryOS Ollama is not installed");
    return this.#apps.control(app.id, action, actor);
  }

  /* -------------------------------- discovery ------------------------------- */

  async view(actor: Actor, signal?: AbortSignal): Promise<LocalModelsView> {
    // Without Docker, native servers are still listed and the Ollama shows as unavailable.
    const app = await this.ollamaApp(actor).catch(() => null);
    const [ollama, servers] = await Promise.all([
      this.ollama(actor, app),
      this.servers(actor, signal, app),
    ]);
    this.#prune();
    return { ollama, servers, pulls: [...this.#pulls.values()].map((pull) => pull.view) };
  }
  async servers(
    actor: Actor,
    signal?: AbortSignal,
    known?: InstalledAppView | null,
  ): Promise<LocalModelServer[]> {
    const [app, containers, sockets] = await Promise.allSettled([
      known === undefined ? this.ollamaApp(actor) : Promise.resolve(known),
      this.#agent.call("docker.containers.list", {}, actor, signal ? { signal } : {}),
      this.#socketsUnsupported
        ? Promise.reject(new Error("unsupported"))
        : this.#agent
            .call("network.sockets", {}, actor, signal ? { signal } : {})
            .catch((error: unknown) => {
              if (error instanceof AgentClientError && error.agentCode === "unsupported")
                this.#socketsUnsupported = true;
              throw error;
            }),
    ]);
    const listening =
      sockets.status === "fulfilled"
        ? sockets.value.listening.filter((socket) => socket.protocol === "tcp")
        : null;
    const access = (port: number): Pick<Candidate, "containerUrl" | "containerAccess"> => {
      const bound = listening?.filter((socket) => socket.port === port) ?? [];
      if (bound.some((socket) => wildcardAddress(socket.address)))
        return { containerUrl: `http://${HOST_GATEWAY}:${port}`, containerAccess: "host-gateway" };
      if (bound.length && bound.every((socket) => loopbackAddress(socket.address)))
        return { containerUrl: null, containerAccess: "loopback-only" };
      return { containerUrl: null, containerAccess: "unknown" };
    };
    const candidates: Candidate[] = [];
    const taken = new Set<number>();
    const everyos = app.status === "fulfilled" ? app.value : null;
    const managed = new Set(this.#apps.managedProjects().map((entry) => entry.project));
    if (everyos) {
      const port = everyos.ports.find((entry) => entry.hostIp === "127.0.0.1")?.port;
      if (port) taken.add(port);
      candidates.push({
        id: "everyos",
        source: "everyos",
        name: "EveryOS Ollama",
        port: port ?? 0,
        hint: "ollama",
        containerUrl: EVERYOS_OLLAMA_NETWORK_URL,
        containerAccess: "network",
        keep: true,
      });
    }
    if (containers.status === "fulfilled" && containers.value.source === "host")
      for (const container of containers.value.containers) {
        if (container.project && managed.has(container.project)) continue;
        const match = SERVER_IMAGES.find(([image]) => image.test(container.image));
        if (!match) continue;
        const published = container.ports.find(
          (port) =>
            port.type === "tcp" &&
            port.privatePort === match[2] &&
            port.publicPort !== null &&
            (port.ip === null || wildcardAddress(port.ip) || loopbackAddress(port.ip)),
        );
        if (!published?.publicPort || taken.has(published.publicPort)) continue;
        taken.add(published.publicPort);
        const everywhere = published.ip === null || wildcardAddress(published.ip);
        candidates.push({
          id: `container:${container.id.slice(0, 12)}`,
          source: "container",
          name: container.name,
          port: published.publicPort,
          hint: match[1],
          containerUrl: everywhere ? `http://${HOST_GATEWAY}:${published.publicPort}` : null,
          containerAccess: everywhere ? "host-gateway" : "loopback-only",
          keep: true,
        });
      }
    const native = new Map<number, LocalServerKind>(
      this.#ports.map(([port, kind]) => [port, kind]),
    );
    for (const socket of listening ?? []) {
      const kind = SERVER_PROCESSES.find(([name]) => name.test(socket.process ?? ""))?.[1];
      if (kind && !native.has(socket.port) && native.size < 12) native.set(socket.port, kind);
    }
    for (const [port, hint] of native)
      if (!taken.has(port))
        candidates.push({
          id: `port:${port}`,
          source: "native",
          name: SERVER_NAMES[hint],
          port,
          hint,
          ...access(port),
          keep: false,
        });
    const servers = await Promise.all(
      candidates.map(async (candidate): Promise<LocalModelServer | null> => {
        const baseUrl = `http://127.0.0.1:${candidate.port}`;
        const probe = candidate.port ? await this.#probe(baseUrl, candidate.hint, signal) : null;
        if (!probe && !candidate.keep) return null;
        const kind = probe?.kind ?? candidate.hint;
        return {
          id: candidate.id,
          kind,
          source: candidate.source,
          name: candidate.source === "native" ? SERVER_NAMES[kind] : candidate.name,
          baseUrl,
          version: probe?.version ?? null,
          online: probe !== null,
          needsKey: probe?.needsKey ?? false,
          models: probe?.models ?? [],
          containerUrl: candidate.containerUrl,
          containerAccess: candidate.containerAccess,
          manageable: kind === "ollama",
        };
      }),
    );
    return servers.filter((server): server is LocalModelServer => server !== null);
  }
  /** A discovered server by id, freshly probed. */
  async server(id: string, actor: Actor): Promise<LocalModelServer> {
    const server = (await this.servers(actor)).find((entry) => entry.id === id);
    if (!server) throw new ApiError(404, "NOT_FOUND", "Local model server not found");
    return server;
  }
  async #probe(
    baseUrl: string,
    hint: LocalServerKind,
    signal?: AbortSignal,
  ): Promise<Pick<LocalModelServer, "kind" | "version" | "needsKey" | "models"> | null> {
    const options: HttpOptions = {
      timeoutMs: 2_500,
      maxBytes: 1024 * 1024,
      ...(signal ? { signal } : {}),
      ...(this.#resolve ? { resolve: this.#resolve } : {}),
    };
    if (hint === "ollama")
      try {
        const version = OllamaVersion.parse(
          await requestJson(joinUrl(baseUrl, "/api/version"), options),
        );
        const tags = OllamaTags.parse(await requestJson(joinUrl(baseUrl, "/api/tags"), options));
        return {
          kind: "ollama",
          version: version.version,
          needsKey: false,
          models: (tags.models ?? []).map((model): LocalModel => ({
            id: model.name,
            size: model.size ?? null,
            parameters: model.details?.parameter_size ?? null,
            quantization: model.details?.quantization_level ?? null,
            family: model.details?.family ?? null,
          })),
        };
      } catch {
        /* Fall back to the OpenAI-compatible listing below. */
      }
    try {
      const listing = OpenAiModels.parse(
        await requestJson(joinUrl(baseUrl, "/v1/models"), options),
      );
      const owner = listing.data.find((model) => model.owned_by)?.owned_by ?? "";
      return {
        kind: /vllm/i.test(owner) ? "vllm" : /llama\.?cpp/i.test(owner) ? "llamacpp" : hint,
        version: null,
        needsKey: false,
        models: listing.data.map((model) => ({
          id: model.id,
          size: null,
          parameters: null,
          quantization: null,
          family: null,
        })),
      };
    } catch (error) {
      return error instanceof IntegrationHttpError && error.kind === "auth"
        ? { kind: hint, version: null, needsKey: true, models: [] }
        : null;
    }
  }

  /* ----------------------------- model management ---------------------------- */

  async pull(
    serverId: string,
    model: string,
    confirmExternal: boolean,
    actor: Actor,
  ): Promise<LocalModelPull> {
    const server = await this.#manageable(serverId, confirmExternal, actor);
    this.#prune();
    const running = [...this.#pulls.values()].filter((pull) => pull.view.state === "running");
    const same = running.find(
      (pull) => pull.view.serverId === serverId && pull.view.model === model,
    );
    if (same) return same.view;
    if (running.length >= MAX_PULLS)
      throw new ApiError(429, "RATE_LIMITED", "Too many model downloads in progress");
    const now = this.#now();
    const pull: Pull = {
      controller: new AbortController(),
      view: {
        id: randomUUID(),
        serverId,
        model,
        state: "running",
        status: "starting",
        completed: 0,
        total: 0,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
    };
    this.#pulls.set(pull.view.id, pull);
    void this.#runPull(pull, server.baseUrl, actor);
    return pull.view;
  }
  cancelPull(id: string): LocalModelPull {
    const pull = this.#pulls.get(id);
    if (!pull) throw new ApiError(404, "NOT_FOUND", "Model download not found");
    pull.controller.abort();
    return pull.view;
  }
  async deleteModel(
    serverId: string,
    model: string,
    confirmExternal: boolean,
    actor: Actor,
  ): Promise<void> {
    const server = await this.#manageable(serverId, confirmExternal, actor);
    if (!server.models.some((entry) => entry.id === model))
      throw new ApiError(404, "NOT_FOUND", "Model not found on this server");
    const response = await ollamaCall(server.baseUrl, "DELETE", "/api/delete", { model });
    response.resume();
    if (response.statusCode !== 200)
      throw new ApiError(502, "AGENT_OPERATION_FAILED", "The model server refused the deletion");
    this.#event("model-delete", actor, "success", { server: serverId, model });
  }
  async #manageable(
    serverId: string,
    confirmExternal: boolean,
    actor: Actor,
  ): Promise<LocalModelServer> {
    const server = await this.server(serverId, actor);
    if (!server.manageable)
      throw new ApiError(409, "CONFLICT", "Only Ollama servers can manage models");
    if (!server.online) throw new ApiError(409, "CONFLICT", "The model server is not running");
    // Models of a server EveryOS did not install may be used by other applications.
    if (server.source !== "everyos" && !confirmExternal)
      throw new ApiError(422, "VALIDATION_FAILED", "External server confirmation required", {
        details: { reason: "external-server" },
      });
    return server;
  }
  async #runPull(pull: Pull, baseUrl: string, actor: Actor): Promise<void> {
    const update = (patch: Partial<LocalModelPull>) => {
      pull.view = { ...pull.view, ...patch, updatedAt: this.#now() };
    };
    try {
      const response = await ollamaCall(
        baseUrl,
        "POST",
        "/api/pull",
        // Older Ollama releases read `name`.
        { model: pull.view.model, name: pull.view.model, stream: true },
        pull.controller.signal,
      );
      if (response.statusCode !== 200) {
        response.resume();
        throw new PullError(`Model server answered HTTP ${response.statusCode ?? 0}`);
      }
      let last = "";
      for await (const line of ndjsonLines(response)) {
        const parsed = PullLine.safeParse(line);
        if (!parsed.success) continue;
        if (parsed.data.error) throw new PullError(parsed.data.error);
        last = parsed.data.status ?? last;
        update({
          status: last.slice(0, 200),
          ...(parsed.data.total !== undefined ? { total: parsed.data.total } : {}),
          ...(parsed.data.completed !== undefined ? { completed: parsed.data.completed } : {}),
        });
      }
      if (last !== "success") throw new PullError("The download ended before it finished");
      update({ state: "succeeded" });
      this.#event("model-pull", actor, "success", {
        server: pull.view.serverId,
        model: pull.view.model,
      });
    } catch (error) {
      const cancelled = pull.controller.signal.aborted;
      update({
        state: cancelled ? "cancelled" : "failed",
        error: cancelled
          ? null
          : error instanceof PullError
            ? error.message.slice(0, 300)
            : "The model server could not be reached",
      });
      this.#event("model-pull", actor, "failure", {
        server: pull.view.serverId,
        model: pull.view.model,
        cancelled,
      });
    }
  }
  #prune(): void {
    for (const [id, pull] of this.#pulls)
      if (pull.view.state !== "running" && this.#now() - pull.view.updatedAt > PULL_RETENTION_MS)
        this.#pulls.delete(id);
  }
  #event(
    action: string,
    actor: Actor,
    outcome: "success" | "failure",
    details: Record<string, string | number | boolean>,
  ) {
    this.#audit.record({
      action: `ai-local.${action}`,
      target: typeof details.server === "string" ? details.server : "ollama",
      outcome,
      ...(actor.kind === "user"
        ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
        : {}),
      details,
    });
  }
}

class PullError extends Error {}

/** A JSON request to a loopback Ollama; its streaming answers are read by the caller. */
function ollamaCall(
  baseUrl: string,
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  const target = new URL(path, baseUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    return Promise.reject(new PullError("Only loopback model servers are managed"));
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      target,
      {
        method,
        agent: false,
        ...(signal ? { signal } : {}),
        headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      },
      (response) => {
        // Ollama verifies large layers silently; once it answered, only cancellation ends a pull.
        request.setTimeout(0);
        resolve(response);
      },
    );
    request.setTimeout(60_000, () => request.destroy(new PullError("Model server timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

/** Newline-delimited JSON, each line bounded. */
async function* ndjsonLines(response: IncomingMessage): AsyncGenerator<unknown> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of response) {
    buffer += decoder.write(chunk as Buffer);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) yield JSON.parse(line) as unknown;
    }
    if (buffer.length > 64 * 1024) throw new PullError("Model server sent an oversized line");
  }
  buffer += decoder.end();
  if (buffer.trim()) yield JSON.parse(buffer.trim()) as unknown;
}
