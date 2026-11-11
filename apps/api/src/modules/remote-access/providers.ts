import {
  AgentClientError,
  type OperationParams,
  type OperationResult,
  type UnaryOperationName,
} from "@everyos/agent-protocol";
import type {
  RemoteAccessNode,
  RemoteAccessPeer,
  RemoteAccessProviderId,
  RemoteAccessSettings,
  RemoteAccessInstallJob,
  RemoteAccessOverview,
} from "@everyos/shared";
import { REMOTE_ACCESS_PROVIDERS } from "@everyos/shared";
import { RemoteAccessSettingsSchema } from "@everyos/shared/schemas";
import { remoteAccessConflicts } from "@everyos/system";
import { toApiError, type UserActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import type { Services } from "../../services.ts";

/** Provider-specific host work stays in the agent. Configuration is public desired state only. */
export interface RemoteAccessProvider {
  readonly id: RemoteAccessProviderId;
  status(actor: UserActor): Promise<RemoteAccessNode>;
  peers(actor: UserActor): Promise<RemoteAccessPeer[]>;
  configure(settings: RemoteAccessSettings, actor: UserActor): RemoteAccessSettings;
  install(configureRepository: boolean, actor: UserActor): Promise<RemoteAccessInstallJob>;
  connect(
    credential: string | undefined,
    acknowledgeConflicts: boolean,
    actor: UserActor,
  ): Promise<RemoteAccessNode>;
  disconnect(actor: UserActor): Promise<RemoteAccessNode>;
}
export function remoteAccessProviders(services: Services) {
  const audit = (
    actor: UserActor,
    provider: RemoteAccessProviderId,
    action: string,
    outcome: "success" | "failure",
  ) =>
    services.audit.record({
      action: `remote-access.${action}`,
      outcome,
      actor: { userId: actor.userId, username: actor.username },
      ip: actor.ip ?? null,
      target: provider,
    });
  const failure = (error: unknown): never => {
    if (error instanceof AgentClientError && /^REMOTE_[A-Z_]+$/.test(error.message))
      throw new ApiError(
        error.agentCode === "conflict" ? 409 : error.agentCode === "invalid_params" ? 400 : 502,
        error.agentCode === "conflict" ? "CONFLICT" : "AGENT_OPERATION_FAILED",
        "Remote access operation failed",
        { details: { reason: error.message } },
      );
    throw toApiError(error);
  };
  const call = async <N extends UnaryOperationName>(
    actor: UserActor,
    op: N,
    params: OperationParams<N>,
  ): Promise<OperationResult<N>> => {
    try {
      return await services.agent.call(op, params, actor);
    } catch (error) {
      services.logger.warn("Remote access agent operation failed", {
        op,
        code: error instanceof AgentClientError ? error.agentCode : "failed",
      });
      return failure(error);
    }
  };
  const saved = (provider: RemoteAccessProviderId) => {
    const row = services.db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      `remote-access.${provider}`,
    );
    if (!row) return null;
    try {
      const parsed = RemoteAccessSettingsSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const defaults = (node: RemoteAccessNode): RemoteAccessSettings => ({
    managementUrl:
      node.provider === "netbird" ? (node.managementUrl ?? "https://api.netbird.io") : null,
    acceptDNS: node.dnsEnabled ?? false,
    acceptRoutes: node.acceptsRoutes ?? false,
  });
  const snapshot = (actor: UserActor) => call(actor, "remoteAccess.snapshot", {});
  const providers = Object.fromEntries(
    REMOTE_ACCESS_PROVIDERS.map((id): [RemoteAccessProviderId, RemoteAccessProvider] => [
      id,
      {
        id,
        async status(actor) {
          const node = (await snapshot(actor)).providers.find((node) => node.provider === id);
          if (!node)
            throw new ApiError(502, "AGENT_OPERATION_FAILED", "Remote access status missing");
          return node;
        },
        async peers(actor) {
          try {
            return (await call(actor, "remoteAccess.peers", { provider: id })).peers;
          } catch (error) {
            return failure(error);
          }
        },
        configure(settings, actor) {
          if (id === "tailscale" && settings.managementUrl !== null)
            throw new ApiError(400, "VALIDATION_FAILED", "Management URL is a NetBird setting");
          services.db.run(
            "INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            `remote-access.${id}`,
            JSON.stringify(settings),
            services.now(),
          );
          audit(actor, id, "configure", "success");
          return settings;
        },
        async install(configureRepository, actor) {
          if (services.updates.jobs().some((job) => job.status === "running"))
            throw new ApiError(409, "CONFLICT", "Another package operation is running");
          try {
            const job = await call(actor, "remoteAccess.install", {
              provider: id,
              configureRepository,
            });
            audit(actor, id, "install", "success");
            return job;
          } catch (error) {
            audit(actor, id, "install", "failure");
            return failure(error);
          }
        },
        async connect(credential, acknowledgeConflicts, actor) {
          try {
            const node = await this.status(actor);
            const settings = saved(id) ?? defaults(node);
            const connected = await call(actor, "remoteAccess.connect", {
              provider: id,
              settings,
              acknowledgeConflicts,
              ...(credential ? { credential } : {}),
            });
            audit(actor, id, "connect", "success");
            return connected;
          } catch (error) {
            audit(actor, id, "connect", "failure");
            return failure(error);
          }
        },
        async disconnect(actor) {
          try {
            const node = await call(actor, "remoteAccess.disconnect", { provider: id });
            audit(actor, id, "disconnect", "success");
            return node;
          } catch (error) {
            audit(actor, id, "disconnect", "failure");
            return failure(error);
          }
        },
      },
    ]),
  ) as Record<RemoteAccessProviderId, RemoteAccessProvider>;
  return {
    providers,
    async overview(actor: UserActor, canManage: boolean): Promise<RemoteAccessOverview> {
      const view = await snapshot(actor);
      return {
        providers: view.providers.map((node) => ({
          node,
          settings: saved(node.provider) ?? defaults(node),
          configured: saved(node.provider) !== null,
          installation: view.installations.find((job) => job.provider === node.provider) ?? null,
        })),
        conflicts: remoteAccessConflicts(view.providers),
        canManage,
      };
    },
  };
}
