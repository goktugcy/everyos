import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import type { SecretBox } from "@everyos/security";
import {
  isOpenWebUiTask,
  type AiAgentKind,
  type AiAgentSettings,
  type AiAgentView,
  type AiAgentDiscovery,
  type AiChatMessage,
  type AiConversation,
  type AppJobView,
  type LocalBehavior,
} from "@everyos/shared";
import type { AiAgentSettingsSchema } from "@everyos/shared/schemas";
import { z } from "zod";
import { ApiError } from "../../http/errors.ts";
import { toApiError } from "../../http/agent.ts";
import type { AgentGateway } from "../../services.ts";
import type { AppService } from "../apps/app-service.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  IntegrationHttpError,
  joinUrl,
  requestJson,
  type HttpOptions,
} from "../integrations/http.ts";
import { localRequest } from "./behavior.ts";
import { AgentRunError, streamAgentChat } from "./chat-client.ts";
import type { LocalModelService } from "./local-models.ts";
import {
  AGENT_MODELS,
  PROVIDER_URLS,
  agentDefaults,
  agentTemplate,
  type AgentRuntime,
} from "./templates.ts";

type Input = z.infer<typeof AiAgentSettingsSchema>;
interface Stored {
  settings: AiAgentSettings;
  gatewayKey: string;
  providerKey: string;
}
interface ConfigRow {
  user_id: string;
  kind: AiAgentKind;
  sealed_settings: string;
  app_id: string | null;
  updated_at: number;
}
interface ChatRow {
  id: string;
  user_id: string;
  kind: AiAgentKind;
  sealed_messages: string;
  updated_at: number;
}
const Messages = z
  .array(
    z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(128 * 1024) }),
  )
  .max(40);
const OllamaVersion = z.object({ version: z.string().max(64) });
const Models = z.object({
  data: z
    .array(z.object({ id: z.string().max(200) }))
    .min(1)
    .max(500),
});

export class AiAgentService {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #apps: AppService;
  readonly #agent: AgentGateway;
  readonly #audit: AuditLog;
  readonly #local: LocalModelService;
  readonly #now: () => number;
  readonly #resolve: HttpOptions["resolve"];
  readonly #busy = new Set<string>();
  readonly #protocols = new Map<string, { at: number; value: "openai" | "ollama" }>();
  readonly #chats = new Map<
    string,
    { controller: AbortController; conversationId: string; finished: Promise<void> }
  >();
  constructor(deps: {
    db: Database;
    secrets: SecretBox;
    apps: AppService;
    agent: AgentGateway;
    audit: AuditLog;
    local: LocalModelService;
    now: () => number;
    resolve?: HttpOptions["resolve"];
  }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#apps = deps.apps;
    this.#agent = deps.agent;
    this.#audit = deps.audit;
    this.#local = deps.local;
    this.#now = deps.now;
    this.#resolve = deps.resolve;
  }
  stop(): void {
    for (const chat of this.#chats.values()) chat.controller.abort();
  }
  async discover(actor: Actor, signal: AbortSignal) {
    const results = await Promise.allSettled([
      this.#agent.call("ai.discover", {}, actor, { signal }),
      this.#agent.call("docker.containers.list", {}, actor, { signal }),
    ]);
    const native = results[0],
      containers = results[1];
    const discoveries: AiAgentDiscovery[] =
      native.status === "fulfilled" ? [...native.value.discoveries] : [];
    const owned = new Set(this.#apps.managedProjects().map((app) => app.project));
    if (containers.status === "fulfilled" && containers.value.source === "host")
      for (const container of containers.value.containers) {
        if (container.project && owned.has(container.project)) continue;
        const kind = /(?:^|\/)nousresearch\/hermes-agent(?::|@|$)/.test(container.image)
          ? "hermes"
          : /(?:^|\/)openclaw\/openclaw(?::|@|$)/.test(container.image)
            ? "openclaw"
            : null;
        if (!kind) continue;
        const port = container.ports.find(
          (port) =>
            port.type === "tcp" &&
            port.privatePort === (kind === "hermes" ? 8642 : 18789) &&
            port.publicPort !== null,
        );
        const id = `container:${container.id}`;
        discoveries.push({
          id,
          kind,
          source: "container",
          name: container.name,
          fingerprint: createHash("sha256").update(id).update(container.image).digest("hex"),
          baseUrl: `http://127.0.0.1:${port?.publicPort ?? (kind === "hermes" ? 8642 : 18789)}`,
          apiModel: AGENT_MODELS[kind],
          canImport: false,
          hasGatewayKey: false,
          hasProviderKey: false,
          historyCount: 0,
          historyWarning: "unreadable",
        });
      }
    return {
      discoveries: discoveries.slice(0, 40),
      source:
        native.status === "fulfilled"
          ? native.value.source
          : containers.status === "fulfilled"
            ? containers.value.source
            : ("host" as const),
      nativeError: native.status === "rejected" ? toApiError(native.reason).code : null,
      dockerError: containers.status === "rejected" ? toApiError(containers.reason).code : null,
    };
  }
  async importNative(
    userId: string,
    kind: AiAgentKind,
    input: { id: string; fingerprint: string; includeSettings: boolean; includeHistory: boolean },
    actor: Actor,
    signal: AbortSignal,
  ) {
    this.#assertFree(userId, kind);
    const key = this.#key(userId, kind);
    this.#busy.add(key);
    try {
      const snapshot = await this.#agent
        .call(
          "ai.snapshot",
          { id: input.id, fingerprint: input.fingerprint, includeHistory: input.includeHistory },
          actor,
          { signal },
        )
        .catch((error: unknown) => {
          throw toApiError(error);
        });
      if (snapshot.discovery.kind !== kind)
        throw new ApiError(400, "VALIDATION_FAILED", "Native agent kind does not match");
      let imported = 0,
        updated = 0,
        skipped = 0,
        removed = 0;
      this.#db.transaction(() => {
        // Earlier imports copied Open WebUI background tasks; drop those never continued here.
        if (input.includeHistory)
          for (const { id } of this.#db.all<{ id: string }>(
            "SELECT chat.id FROM ai_agent_imports AS record JOIN ai_conversations AS chat ON chat.id = record.conversation_id AND chat.user_id = record.user_id WHERE record.user_id = ? AND record.kind = ?",
            userId,
            kind,
          )) {
            const { messages } = this.conversation(userId, kind, id);
            // A continued task has more than its imported prompt and answer and is kept.
            if (messages.length > 2 || !isOpenWebUiTask(messages[0]?.content ?? "")) continue;
            this.#db.run(
              "DELETE FROM ai_agent_imports WHERE user_id = ? AND conversation_id = ?",
              userId,
              id,
            );
            this.#db.run("DELETE FROM ai_conversations WHERE id = ? AND user_id = ?", id, userId);
            removed++;
          }
        if (input.includeSettings)
          this.#record(
            userId,
            kind,
            {
              settings: snapshot.settings,
              gatewayKey: snapshot.gatewayKey ?? "",
              providerKey: snapshot.providerKey ?? "",
            },
            this.#row(userId, kind)?.app_id ?? null,
          );
        if (input.includeHistory)
          for (const chat of snapshot.conversations) {
            const sourceId = `${input.id}:${chat.sourceId}`;
            const messages = JSON.stringify(
              chat.messages.map((message) => ({
                ...message,
                content: [snapshot.gatewayKey, snapshot.providerKey]
                  .filter((key): key is string => Boolean(key))
                  .reduce((content, key) => content.replaceAll(key, "[REDACTED]"), message.content),
              })),
            );
            const existing = this.#db.get<ChatRow>(
              "SELECT chat.* FROM ai_agent_imports AS record JOIN ai_conversations AS chat ON chat.id = record.conversation_id AND chat.user_id = record.user_id WHERE record.user_id = ? AND record.kind = ? AND record.source_id = ?",
              userId,
              kind,
              sourceId,
            );
            if (existing) {
              // Continuing a chat moves its timestamp; a copy still at the source's is refreshed.
              if (
                chat.messages.length &&
                chat.updatedAt > 0 &&
                existing.updated_at === chat.updatedAt &&
                JSON.stringify(this.#conversation(existing).messages) !== messages
              ) {
                this.#db.run(
                  "UPDATE ai_conversations SET sealed_messages = ? WHERE id = ? AND user_id = ?",
                  this.#secrets.seal(messages, `ai-chat:${userId}:${existing.id}:messages:v1`),
                  existing.id,
                  userId,
                );
                updated++;
              } else skipped++;
              continue;
            }
            if (this.conversations(userId, kind).length >= 50 || !chat.messages.length) {
              skipped++;
              continue;
            }
            const id = randomUUID();
            this.#db.run(
              "INSERT INTO ai_conversations(id, user_id, kind, sealed_messages, updated_at) VALUES (?, ?, ?, ?, ?)",
              id,
              userId,
              kind,
              this.#secrets.seal(messages, `ai-chat:${userId}:${id}:messages:v1`),
              chat.updatedAt || this.#now(),
            );
            this.#db.run(
              "INSERT INTO ai_agent_imports(user_id, kind, source_id, conversation_id) VALUES (?, ?, ?, ?)",
              userId,
              kind,
              sourceId,
              id,
            );
            imported++;
          }
      });
      this.#event("import", actor, kind, "success", {
        source: input.id,
        settings: input.includeSettings,
        imported,
        updated,
        skipped,
        removed,
      });
      return {
        imported,
        updated,
        skipped,
        removed,
        warning: snapshot.discovery.historyWarning,
        missingGatewayKey: input.includeSettings && !snapshot.gatewayKey,
      };
    } finally {
      this.#busy.delete(key);
    }
  }
  #key(userId: string, kind: AiAgentKind) {
    return `${userId}:${kind}`;
  }
  #row(userId: string, kind: AiAgentKind): ConfigRow | null {
    return (
      this.#db.get<ConfigRow>(
        "SELECT * FROM ai_agent_configs WHERE user_id = ? AND kind = ?",
        userId,
        kind,
      ) ?? null
    );
  }
  #stored(row: ConfigRow): Stored {
    return JSON.parse(
      this.#secrets.open(row.sealed_settings, `ai-agent:${row.user_id}:${row.kind}:settings:v1`),
    ) as Stored;
  }
  #record(userId: string, kind: AiAgentKind, stored: Stored, appId: string | null) {
    this.#db.run(
      "INSERT INTO ai_agent_configs(user_id, kind, sealed_settings, app_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET sealed_settings = excluded.sealed_settings, app_id = excluded.app_id, updated_at = excluded.updated_at",
      userId,
      kind,
      this.#secrets.seal(JSON.stringify(stored), `ai-agent:${userId}:${kind}:settings:v1`),
      appId,
      this.#now(),
    );
  }
  #assertFree(userId: string, kind: AiAgentKind): void {
    if (this.#busy.has(this.#key(userId, kind)))
      throw new ApiError(409, "CONFLICT", "Agent operation in progress");
  }
  #event(
    action: string,
    actor: Actor,
    kind: AiAgentKind,
    outcome: "success" | "failure",
    details: Record<string, string | number | boolean> = {},
  ) {
    this.#audit.record({
      action: `ai-agent.${action}`,
      target: kind,
      outcome,
      ...(actor.kind === "user"
        ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
        : {}),
      details,
    });
  }
  async view(
    userId: string,
    kind: AiAgentKind,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<AiAgentView> {
    const row = this.#row(userId, kind);
    const stored = row ? this.#stored(row) : null;
    const settings = stored?.settings ?? agentDefaults(kind);
    // A managed local model is the system-wide EveryOS Ollama, not a per-account app.
    let unreachable = false;
    const app =
      kind === "local"
        ? row && settings.mode === "managed"
          ? await this.#local.ollamaApp(actor).catch(() => {
              unreachable = true;
              return null;
            })
          : null
        : row?.app_id
          ? ((await this.#apps.list(actor)).find((app) => app.id === row.app_id) ?? null)
          : null;
    const busy = this.#busy.has(this.#key(userId, kind)) || app?.state === "busy";
    const view: AiAgentView = {
      kind,
      configured: row !== null,
      settings,
      hasGatewayKey: Boolean(stored?.gatewayKey),
      hasProviderKey: Boolean(stored?.providerKey),
      app,
      source: settings.mode === "managed" ? (app?.source ?? "host") : "host",
      status: !row
        ? "unconfigured"
        : settings.mode === "managed" && !app
          ? "not-installed"
          : "unknown",
      busy,
      job: app?.lastJob ?? null,
    };
    // Docker could not be asked: the EveryOS Ollama may still exist.
    if (unreachable) {
      view.status = "offline";
      return view;
    }
    if (!row || (settings.mode === "managed" && !app)) return view;
    // Local model servers usually need no key.
    if (settings.mode === "external" && !stored?.gatewayKey && kind !== "local") {
      view.status = "unconfigured";
      return view;
    }
    if (settings.mode === "managed" && app?.source === "simulated") {
      view.status =
        app.state === "running" ? "unknown" : app.state === "busy" ? "starting" : "stopped";
      return view;
    }
    if (settings.mode === "managed" && app && app.state !== "running") {
      view.status = app.state === "busy" || app.state === "degraded" ? "starting" : "stopped";
      return view;
    }
    if (app?.lastError) {
      view.status = "error";
      return view;
    }
    try {
      const base = await this.#base(row, actor);
      const result = await requestJson(joinUrl(base, "/v1/models"), {
        headers: stored!.gatewayKey ? { Authorization: `Bearer ${stored!.gatewayKey}` } : {},
        maxBytes: 256 * 1024,
        ...(signal ? { signal } : {}),
        ...(this.#resolve ? { resolve: this.#resolve } : {}),
      });
      const parsed = Models.safeParse(result);
      view.status =
        parsed.success && parsed.data.data.some((model) => model.id === settings.apiModel)
          ? "running"
          : "error";
    } catch (error) {
      view.status =
        error instanceof IntegrationHttpError && error.kind === "auth"
          ? "auth-failed"
          : error instanceof ApiError && error.status === 409
            ? "starting"
            : "offline";
    }
    return view;
  }
  async #base(row: ConfigRow, actor: Actor): Promise<string> {
    const stored = this.#stored(row);
    if (stored.settings.mode === "external") return stored.settings.baseUrl.replace(/\/v1\/?$/, "");
    if (row.kind === "local") return this.#local.ollamaBase(actor);
    if (!row.app_id) throw new ApiError(409, "CONFLICT", "Agent is not installed");
    const app = (await this.#apps.list(actor)).find((entry) => entry.id === row.app_id);
    if (!app || app.source === "simulated" || app.state !== "running" || app.lastError)
      throw new ApiError(409, "CONFLICT", "Agent is not ready");
    const port = app.ports.find((entry) => entry.hostIp === "127.0.0.1");
    if (!port) throw new ApiError(409, "CONFLICT", "Agent API port not available");
    return `http://127.0.0.1:${port.port}`;
  }
  async save(
    userId: string,
    kind: AiAgentKind,
    input: Input,
    actor: Actor,
  ): Promise<AppJobView | null> {
    this.#assertFree(userId, kind);
    const key = this.#key(userId, kind);
    this.#busy.add(key);
    try {
      const previous = this.#row(userId, kind);
      const old = previous ? this.#stored(previous) : null;
      const { gatewayKey, providerKey, clearProviderKey, ...settings } = input;
      // Behavior belongs to local chats; a save that omits it keeps the stored one.
      if (kind === "local") settings.behavior = settings.behavior ?? old?.settings.behavior;
      else delete settings.behavior;
      if (kind === "local") {
        // A direct chat: the server is the model provider; the chosen model is its API model.
        settings.provider = "custom";
        settings.providerUrl = `${settings.baseUrl.replace(/\/v1\/?$/, "")}/v1`;
        settings.model = settings.apiModel;
        settings.tools = false;
      }
      settings.providerUrl =
        settings.provider === "custom" ? settings.providerUrl : PROVIDER_URLS[settings.provider];
      if (settings.mode === "managed" && kind !== "local") settings.apiModel = AGENT_MODELS[kind];
      const stored: Stored = {
        settings,
        gatewayKey:
          kind === "local" && settings.mode === "managed"
            ? ""
            : settings.mode === "managed"
              ? old?.settings.mode === "managed"
                ? old.gatewayKey
                : randomBytes(32).toString("hex")
              : gatewayKey ||
                (old?.settings.mode === "external" && old.settings.baseUrl === settings.baseUrl
                  ? old.gatewayKey
                  : ""),
        providerKey:
          clearProviderKey || kind === "local"
            ? ""
            : providerKey ||
              (old?.settings.providerUrl === settings.providerUrl ? old.providerKey : ""),
      };
      if (settings.mode === "external" && !stored.gatewayKey && kind !== "local")
        throw new ApiError(422, "VALIDATION_FAILED", "Agent API token required");
      if (
        settings.mode === "managed" &&
        kind !== "local" &&
        (settings.provider === "openrouter" || settings.provider === "openai") &&
        !stored.providerKey
      )
        throw new ApiError(422, "VALIDATION_FAILED", "Model provider API key required");
      if (settings.mode === "managed" && settings.provider === "ollama" && kind !== "local")
        if (!(await this.#local.ollamaApp(actor)))
          throw new ApiError(409, "CONFLICT", "Install the EveryOS Ollama first", {
            details: { reason: "ollama-missing" },
          });
      let job: AppJobView | null = null;
      const appId =
        kind !== "local" && previous?.app_id && this.#apps.exists(previous.app_id)
          ? previous.app_id
          : null;
      if (settings.mode === "managed" && appId)
        job = await this.#apps.configureBuiltin(
          appId,
          agentTemplate(kind as AgentRuntime, settings, stored.gatewayKey, stored.providerKey),
          actor,
        );
      this.#record(userId, kind, stored, appId);
      this.#event("configure", actor, kind, "success", {
        mode: settings.mode,
        tools: settings.tools,
      });
      return job;
    } finally {
      this.#busy.delete(key);
    }
  }
  async install(userId: string, kind: AiAgentKind, actor: Actor): Promise<AppJobView> {
    this.#assertFree(userId, kind);
    const key = this.#key(userId, kind);
    this.#busy.add(key);
    try {
      // The EveryOS Ollama is installed system-wide from the local model settings.
      if (kind === "local")
        throw new ApiError(409, "CONFLICT", "Local models are not installed per account");
      const row = this.#row(userId, kind);
      if (!row) throw new ApiError(409, "CONFLICT", "Configure the agent first");
      const stored = this.#stored(row);
      if (stored.settings.mode !== "managed")
        throw new ApiError(409, "CONFLICT", "External agents are not installed by EveryOS");
      if (row.app_id && this.#apps.exists(row.app_id))
        throw new ApiError(409, "CONFLICT", "Agent already installed");
      const status = await this.#agent.call("docker.status", {}, actor);
      if (!status.status.available || !status.compose.available)
        throw new ApiError(409, "CONFLICT", "Docker and Compose v2 are required");
      if (stored.settings.provider === "ollama" && !(await this.#local.ollamaApp(actor)))
        throw new ApiError(409, "CONFLICT", "Install the EveryOS Ollama first", {
          details: { reason: "ollama-missing" },
        });
      const job = await this.#apps.installBuiltin(
        agentTemplate(kind, stored.settings, stored.gatewayKey, stored.providerKey),
        actor,
      );
      this.#record(userId, kind, stored, job.appId);
      this.#event("install", actor, kind, "success");
      return job;
    } finally {
      this.#busy.delete(key);
    }
  }
  async control(
    userId: string,
    kind: AiAgentKind,
    action: "start" | "stop" | "restart" | "retry",
    actor: Actor,
  ): Promise<AppJobView> {
    this.#assertFree(userId, kind);
    const row = this.#row(userId, kind);
    if (kind === "local" || !row?.app_id || this.#stored(row).settings.mode !== "managed")
      throw new ApiError(409, "CONFLICT", "No managed agent installation");
    return this.#apps.control(row.app_id, action, actor);
  }
  #conversation(row: ChatRow): AiConversation {
    const messages = Messages.parse(
      JSON.parse(
        this.#secrets.open(row.sealed_messages, `ai-chat:${row.user_id}:${row.id}:messages:v1`),
      ),
    );
    return {
      id: row.id,
      kind: row.kind,
      title: messages.find((message) => message.role === "user")?.content.slice(0, 64) ?? "",
      updatedAt: row.updated_at,
      messages,
    };
  }
  conversations(userId: string, kind: AiAgentKind): Omit<AiConversation, "messages">[] {
    return this.#db
      .all<ChatRow>(
        "SELECT * FROM ai_conversations WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC",
        userId,
        kind,
      )
      .map((row) => {
        const { messages: _messages, ...view } = this.#conversation(row);
        return view;
      });
  }
  conversation(userId: string, kind: AiAgentKind, id: string): AiConversation {
    const row = this.#db.get<ChatRow>(
      "SELECT * FROM ai_conversations WHERE id = ? AND user_id = ? AND kind = ?",
      id,
      userId,
      kind,
    );
    if (!row) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
    return this.#conversation(row);
  }
  createConversation(userId: string, kind: AiAgentKind): AiConversation {
    if (this.conversations(userId, kind).length >= 50)
      throw new ApiError(409, "CONFLICT", "Conversation limit reached");
    const id = randomUUID();
    this.#db.run(
      "INSERT INTO ai_conversations(id, user_id, kind, sealed_messages, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      userId,
      kind,
      this.#secrets.seal("[]", `ai-chat:${userId}:${id}:messages:v1`),
      this.#now(),
    );
    return this.conversation(userId, kind, id);
  }
  deleteConversation(userId: string, kind: AiAgentKind, id: string, actor: Actor): void {
    this.#assertFree(userId, kind);
    this.conversation(userId, kind, id);
    this.#db.run("DELETE FROM ai_conversations WHERE id = ? AND user_id = ?", id, userId);
    this.#event("delete-chat", actor, kind, "success", { conversationId: id });
  }
  /** One streamed turn; local chats add their behavior and may use Ollama's own API. */
  async #stream(
    row: ConfigRow,
    stored: Stored,
    base: string,
    messages: AiChatMessage[],
    options: {
      user: string;
      signal: AbortSignal;
      onDelta: (text: string) => Promise<void>;
      behavior?: LocalBehavior;
    },
  ): Promise<string> {
    const local = row.kind === "local";
    const protocol = local ? await this.#protocol(row, base) : "openai";
    const request = local
      ? localRequest(options.behavior ?? stored.settings.behavior, protocol)
      : null;
    return streamAgentChat({
      url: joinUrl(base, protocol === "ollama" ? "/api/chat" : "/v1/chat/completions"),
      key: stored.gatewayKey,
      model: stored.settings.apiModel,
      user: options.user,
      messages: request ? [{ role: "system", content: request.system }, ...messages] : messages,
      signal: options.signal,
      onDelta: options.onDelta,
      redactSecrets: [stored.providerKey],
      ...(request ? { protocol, parameters: request.parameters } : {}),
      ...(this.#resolve ? { resolve: this.#resolve } : {}),
    });
  }
  /** Ollama's own API also applies memory and repetition; other servers get OpenAI fields. */
  async #protocol(row: ConfigRow, base: string): Promise<"openai" | "ollama"> {
    if (this.#stored(row).settings.mode === "managed") return "ollama";
    const cached = this.#protocols.get(base);
    if (cached && this.#now() - cached.at < 5 * 60_000) return cached.value;
    const value = await requestJson(joinUrl(base, "/api/version"), {
      timeoutMs: 2_000,
      maxBytes: 4096,
      ...(this.#resolve ? { resolve: this.#resolve } : {}),
    }).then(
      (result) => (OllamaVersion.safeParse(result).success ? "ollama" : "openai"),
      () => "openai" as const,
    );
    this.#protocols.set(base, { at: this.#now(), value });
    return value;
  }
  /** Tries unsaved behavior settings on the saved local model; nothing is stored. */
  beginPreview(userId: string, behavior: LocalBehavior, prompt: string, actor: Actor) {
    this.#assertFree(userId, "local");
    const row = this.#row(userId, "local");
    if (!row) throw new ApiError(409, "CONFLICT", "Configure the local model first");
    const key = this.#key(userId, "local");
    return async (signal: AbortSignal, onDelta: (text: string) => Promise<void>) => {
      this.#assertFree(userId, "local");
      this.#busy.add(key);
      try {
        const stored = this.#stored(row);
        const answer = await this.#stream(
          row,
          stored,
          await this.#base(row, actor),
          [{ role: "user", content: prompt }],
          { user: `everyos-${userId}-preview`, signal, onDelta, behavior },
        );
        this.#event("preview", actor, "local", "success");
        return answer;
      } catch (error) {
        this.#event("preview", actor, "local", "failure");
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, "AGENT_OPERATION_FAILED", "Agent chat failed", {
          details:
            error instanceof AgentRunError
              ? { reason: "agent-error", message: error.detail }
              : { reason: error instanceof IntegrationHttpError ? error.kind : "offline" },
        });
      } finally {
        this.#busy.delete(key);
      }
    };
  }
  beginChat(userId: string, kind: AiAgentKind, id: string, content: string, actor: Actor) {
    this.#assertFree(userId, kind);
    const row = this.#row(userId, kind);
    if (!row) throw new ApiError(409, "CONFLICT", "Configure the agent first");
    const conversation = this.conversation(userId, kind, id);
    if (
      conversation.messages.length >= 40 ||
      Buffer.byteLength(JSON.stringify(conversation.messages)) + Buffer.byteLength(content) >
        128 * 1024
    )
      throw new ApiError(409, "CONFLICT", "Start a new conversation");
    const key = this.#key(userId, kind),
      controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    return async (
      signal: AbortSignal,
      onDelta: (text: string) => Promise<void>,
    ): Promise<AiConversation> => {
      this.#assertFree(userId, kind);
      if (signal.aborted) throw new ApiError(409, "CONFLICT", "Chat cancelled");
      if (this.#row(userId, kind)?.sealed_settings !== row.sealed_settings)
        throw new ApiError(409, "CONFLICT", "Agent settings changed before execution");
      const currentConversation = this.conversation(userId, kind, id);
      if (currentConversation.messages.length >= 40)
        throw new ApiError(409, "CONFLICT", "Start a new conversation");
      this.#busy.add(key);
      this.#chats.set(key, { controller, conversationId: id, finished: finished.promise });
      try {
        const stored = this.#stored(row),
          base = await this.#base(row, actor);
        const messages: AiChatMessage[] = [
          ...currentConversation.messages,
          { role: "user", content },
        ];
        const answer = await this.#stream(row, stored, base, messages, {
          user: `everyos-${userId}-${id}`,
          signal: AbortSignal.any([signal, controller.signal]),
          onDelta,
        });
        if (signal.aborted || controller.signal.aborted)
          throw new ApiError(409, "CONFLICT", "Chat cancelled");
        messages.push({ role: "assistant", content: answer });
        this.#db.run(
          "UPDATE ai_conversations SET sealed_messages = ?, updated_at = ? WHERE id = ? AND user_id = ?",
          this.#secrets.seal(
            JSON.stringify(
              messages.map((message) => ({
                ...message,
                content: [stored.gatewayKey, stored.providerKey]
                  .filter(Boolean)
                  .reduce((content, key) => content.replaceAll(key, "[REDACTED]"), message.content),
              })),
            ),
            `ai-chat:${userId}:${id}:messages:v1`,
          ),
          this.#now(),
          id,
          userId,
        );
        this.#event("chat", actor, kind, "success", {
          conversationId: id,
          messages: messages.length,
        });
        return this.conversation(userId, kind, id);
      } catch (error) {
        this.#event("chat", actor, kind, "failure", {
          conversationId: id,
          cancelled: signal.aborted || controller.signal.aborted,
        });
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, "AGENT_OPERATION_FAILED", "Agent chat failed", {
          details:
            error instanceof AgentRunError
              ? { reason: "agent-error", message: error.detail }
              : { reason: error instanceof IntegrationHttpError ? error.kind : "offline" },
        });
      } finally {
        this.#busy.delete(key);
        this.#chats.delete(key);
        finished.resolve();
      }
    };
  }
  async cancelChat(userId: string, kind: AiAgentKind, id: string) {
    this.conversation(userId, kind, id);
    const chat = this.#chats.get(this.#key(userId, kind));
    if (!chat) return { cancelled: false };
    if (chat.conversationId !== id)
      throw new ApiError(409, "CONFLICT", "Another conversation is active");
    chat.controller.abort();
    await chat.finished;
    return { cancelled: true };
  }
}
