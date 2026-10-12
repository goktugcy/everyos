import { randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import type { SecretBox } from "@everyos/security";
import {
  INTEGRATION_TOPIC_PATTERN,
  HOME_ASSISTANT_SERVICES,
  type HomeAssistantAction,
  type IntegrationAdapter,
  type IntegrationAudience,
  type IntegrationOptions,
  type IntegrationView,
  type Permission,
} from "@everyos/shared";
import { AgentClientError } from "@everyos/agent-protocol";
import { ApiError } from "../../http/errors.ts";
import type { AgentGateway } from "../../services.ts";
import type { DataProvider, ProviderResult } from "../widgets/data-hub.ts";
import {
  ADAPTERS,
  callHomeAssistant,
  homeAssistantTarget,
  NotConfiguredError,
  type AdapterContext,
} from "./adapters.ts";
import { IntegrationHttpError, type HttpOptions } from "./http.ts";

interface IntegrationRow {
  id: string;
  adapter: IntegrationAdapter;
  name: string;
  app_id: string | null;
  base_url: string | null;
  audience: IntegrationAudience;
  username: string | null;
  secret: string | null;
  options: string;
  created_at: number;
  updated_at: number;
}

const SYSTEM_ACTOR: Actor = { kind: "system", component: "widgets" };

export interface IntegrationInput {
  adapter?: IntegrationAdapter | undefined;
  name?: string | undefined;
  appId?: string | null | undefined;
  baseUrl?: string | null | undefined;
  audience?: IntegrationAudience | undefined;
  secret?: string | undefined;
  username?: string | undefined;
  clearSecret?: boolean | undefined;
  options?: IntegrationOptions | undefined;
}

/** Permissions a viewer needs to read an integration's data. */
export function audiencePermissions(audience: IntegrationAudience): Permission[] {
  return audience === "everyone" ? ["apps:read"] : ["apps:read", "apps:manage"];
}

/** Maps adapter failures to topic states shown by widgets. */
export function toProviderResult(error: unknown): ProviderResult {
  if (error instanceof NotConfiguredError)
    return { status: "unavailable", reason: "not-configured" };
  if (error instanceof IntegrationHttpError) {
    switch (error.kind) {
      case "auth":
        return { status: "unavailable", reason: "auth-failed" };
      case "offline":
        return { status: "unavailable", reason: "app-offline" };
      case "status":
        return error.status !== null && error.status >= 500
          ? { status: "unavailable", reason: "app-offline" }
          : { status: "error", code: "APP_API_ERROR" };
      case "unsafe-address":
        return { status: "error", code: "UNSAFE_ADDRESS" };
      case "invalid":
      case "too-large":
        return { status: "error", code: "INVALID_RESPONSE" };
    }
  }
  if (error instanceof AgentClientError) {
    if (error.code === "AGENT_UNAVAILABLE") return { status: "unavailable", reason: "app-offline" };
    if (error.agentCode === "not_found") return { status: "unavailable", reason: "not-configured" };
    if (error.agentCode === "conflict") return { status: "unavailable", reason: "app-offline" };
    return { status: "error", code: error.agentCode ?? error.code };
  }
  return { status: "error", code: "INTERNAL_ERROR" };
}

/**
 * Application integrations for widgets. An administrator (apps:manage)
 * creates them, which is the explicit consent to read that app's API.
 * Credentials are sealed with the secret box and never returned; data is
 * visible to `audience` only.
 */
export class IntegrationService {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #agent: AgentGateway;
  readonly #now: () => number;
  readonly #appExists: (appId: string) => boolean;
  readonly #resolve: HttpOptions["resolve"];

  constructor(deps: {
    db: Database;
    secrets: SecretBox;
    agent: AgentGateway;
    now: () => number;
    appExists: (appId: string) => boolean;
    resolve?: HttpOptions["resolve"];
  }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#agent = deps.agent;
    this.#now = deps.now;
    this.#appExists = deps.appExists;
    this.#resolve = deps.resolve;
  }

  #row(id: string): IntegrationRow | null {
    return this.#db.get<IntegrationRow>("SELECT * FROM integrations WHERE id = ?", id) ?? null;
  }

  #options(row: IntegrationRow): IntegrationOptions {
    try {
      return JSON.parse(row.options) as IntegrationOptions;
    } catch {
      return {};
    }
  }

  #view(row: IntegrationRow): IntegrationView {
    return {
      id: row.id,
      adapter: row.adapter,
      name: row.name,
      appId: row.app_id,
      appMissing: row.app_id !== null && !this.#appExists(row.app_id),
      baseUrl: row.base_url,
      audience: row.audience,
      hasCredentials: row.secret !== null,
      options: this.#options(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Integrations whose data the viewer may see (managers see all). */
  list(permissions: ReadonlySet<Permission>): IntegrationView[] {
    return this.#db
      .all<IntegrationRow>("SELECT * FROM integrations ORDER BY name")
      .filter((row) => audiencePermissions(row.audience).every((p) => permissions.has(p)))
      .map((row) => this.#view(row));
  }

  get(id: string): IntegrationView | null {
    const row = this.#row(id);
    return row ? this.#view(row) : null;
  }

  #validate(adapter: IntegrationAdapter, baseUrl: string | null, appId: string | null): void {
    if (ADAPTERS[adapter].needsBaseUrl && !baseUrl)
      throw new ApiError(400, "VALIDATION_FAILED", "This integration needs the app's URL");
    if (appId !== null && !this.#appExists(appId))
      throw new ApiError(404, "NOT_FOUND", "Application not found");
  }

  create(
    input: IntegrationInput & { adapter: IntegrationAdapter; name: string },
    userId: string,
  ): IntegrationView {
    const baseUrl = input.baseUrl ?? null;
    const appId = input.appId ?? null;
    this.#validate(input.adapter, baseUrl, appId);
    const id = randomUUID();
    const now = this.#now();
    this.#db.run(
      `INSERT INTO integrations (id, adapter, name, app_id, base_url, audience, username, secret, options, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.adapter,
      input.name,
      appId,
      baseUrl,
      input.audience ?? "managers",
      input.username ?? null,
      input.secret ? this.#secrets.seal(input.secret, `integration:${id}:secret:v1`) : null,
      JSON.stringify(input.options ?? {}),
      userId,
      now,
      now,
    );
    return this.#view(this.#row(id)!);
  }

  update(id: string, patch: IntegrationInput): IntegrationView {
    const row = this.#row(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Integration not found");
    const baseUrl = patch.baseUrl === undefined ? row.base_url : patch.baseUrl;
    const appId = patch.appId === undefined ? row.app_id : patch.appId;
    this.#validate(row.adapter, baseUrl, appId);
    const secret = patch.clearSecret
      ? null
      : patch.secret
        ? this.#secrets.seal(patch.secret, `integration:${id}:secret:v1`)
        : row.secret;
    this.#db.run(
      `UPDATE integrations SET name = ?, app_id = ?, base_url = ?, audience = ?, username = ?, secret = ?, options = ?, updated_at = ? WHERE id = ?`,
      patch.name ?? row.name,
      appId,
      baseUrl,
      patch.audience ?? row.audience,
      patch.username === undefined ? row.username : patch.username,
      secret,
      patch.options === undefined ? row.options : JSON.stringify(patch.options),
      this.#now(),
      id,
    );
    return this.#view(this.#row(id)!);
  }

  remove(id: string): boolean {
    return this.#db.run("DELETE FROM integrations WHERE id = ?", id).changes > 0;
  }

  #context(row: IntegrationRow, signal: AbortSignal): AdapterContext {
    return {
      baseUrl: row.base_url,
      secret: row.secret ? this.#secrets.open(row.secret, `integration:${row.id}:secret:v1`) : null,
      username: row.username,
      options: this.#options(row),
      signal,
      ...(this.#resolve ? { resolve: this.#resolve } : {}),
      agent: {
        postgresStats: (container, user, database) =>
          this.#agent.call("apps.postgres.stats", { container, user, database }, SYSTEM_ACTOR, {
            signal,
          }),
        containerState: async (container) => {
          const { containers } = await this.#agent.call(
            "docker.containers.list",
            {},
            SYSTEM_ACTOR,
            { signal },
          );
          const found = containers.find((c) => c.name === container || c.id.startsWith(container));
          return found ? { state: found.state, health: found.health } : null;
        },
      },
    };
  }

  async #collect(row: IntegrationRow, feed: string, signal: AbortSignal): Promise<ProviderResult> {
    if (row.app_id !== null && !this.#appExists(row.app_id))
      return { status: "unavailable", reason: "app-removed" };
    const definition = ADAPTERS[row.adapter].feeds[feed];
    if (!definition) return { status: "error", code: "NOT_FOUND" };
    try {
      return { status: "ok", data: await definition.collect(this.#context(row, signal)) };
    } catch (error) {
      return toProviderResult(error);
    }
  }

  /** Data provider for `data.integration.<id>.<feed>`, or null when unknown. */
  provider(topic: string): DataProvider | null {
    const match = INTEGRATION_TOPIC_PATTERN.exec(topic);
    if (!match) return null;
    const row = this.#row(match[1]!);
    const feed = match[2]!;
    const definition = row ? ADAPTERS[row.adapter].feeds[feed] : undefined;
    if (!row || !definition) return null;
    return {
      topic,
      permissions: audiencePermissions(row.audience),
      intervalMs: definition.intervalMs,
      // The row is read again on every collection, so edits apply immediately.
      collect: (signal) => {
        const current = this.#row(row.id);
        return current
          ? this.#collect(current, feed, signal)
          : Promise.resolve({ status: "error", code: "NOT_FOUND" });
      },
    };
  }

  /** Runs the adapter's main feed once ("Test connection"). */
  async test(id: string, signal: AbortSignal): Promise<ProviderResult> {
    const row = this.#row(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Integration not found");
    return this.#collect(row, ADAPTERS[row.adapter].testFeed, signal);
  }

  /** Home Assistant quick control, limited to the entities an administrator allowed. */
  async control(id: string, action: HomeAssistantAction, signal: AbortSignal): Promise<void> {
    const row = this.#row(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Integration not found");
    if (row.adapter !== "homeassistant")
      throw new ApiError(400, "VALIDATION_FAILED", "This integration has no controls");
    const { entityId } = action;
    const options = this.#options(row);
    const domain = entityId.split(".")[0]!;
    if (
      !Object.hasOwn(HOME_ASSISTANT_SERVICES, domain) ||
      (options.controlScope !== "all" && !(options.controlEntities ?? []).includes(entityId))
    )
      throw new ApiError(403, "FORBIDDEN", "This entity is not allowed for quick controls");
    if (row.app_id !== null && !this.#appExists(row.app_id))
      throw new ApiError(409, "CONFLICT", "Linked application was removed");
    if (action.service === "unlock" && action.confirm !== true)
      throw new ApiError(400, "VALIDATION_FAILED", "Unlocking requires explicit confirmation");
    try {
      const context = this.#context(row, signal);
      const entity = await homeAssistantTarget(context, entityId);
      const service =
        action.service === "toggle" && domain === "script"
          ? "turn_on"
          : action.service === "toggle" && domain === "cover"
            ? entity.state === "open"
              ? "close_cover"
              : "open_cover"
            : action.service;
      if (!entity.actions.includes(service))
        throw new ApiError(400, "VALIDATION_FAILED", "This entity does not support the action");
      if (entity.state === "unavailable" || entity.state === "unknown")
        throw new ApiError(409, "CONFLICT", "This entity is unavailable");
      const value =
        action.service === "set_temperature"
          ? action.temperature
          : action.service === "set_value"
            ? action.value
            : null;
      if (
        value !== null &&
        (entity.min === null || entity.max === null || value < entity.min || value > entity.max)
      )
        throw new ApiError(400, "VALIDATION_FAILED", "Value outside the entity's supported range");
      if (
        (action.service === "select_option" && !entity.options.includes(action.option)) ||
        (action.service === "set_hvac_mode" && !entity.options.includes(action.hvacMode))
      )
        throw new ApiError(400, "VALIDATION_FAILED", "This entity does not support the option");
      const current = this.#row(id);
      if (!current) throw new ApiError(404, "NOT_FOUND", "Integration was removed");
      if (
        current.updated_at !== row.updated_at ||
        current.options !== row.options ||
        current.base_url !== row.base_url ||
        current.secret !== row.secret ||
        current.audience !== row.audience ||
        current.app_id !== row.app_id
      )
        throw new ApiError(409, "CONFLICT", "Integration settings changed before execution");
      if (current.app_id !== null && !this.#appExists(current.app_id))
        throw new ApiError(409, "CONFLICT", "Linked application was removed");
      await callHomeAssistant(context, action, service);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const result = toProviderResult(error);
      throw new ApiError(502, "AGENT_OPERATION_FAILED", "The app did not accept the action", {
        details: {
          reason:
            result.status === "unavailable"
              ? result.reason
              : result.status === "error"
                ? result.code
                : "ok",
        },
      });
    }
  }
}
