import {
  AgentClient,
  AgentClientError,
  type Actor,
  type AgentConnectionState,
  type OperationName,
  type OperationParams,
  type OperationResult,
} from "@otuken/agent-protocol";
import type { Logger } from "@otuken/logger";
import { KeyFileError, loadKeyFile } from "@otuken/security";
import type { AgentGateway } from "./services.ts";

const KEY_RETRY_MS = 5_000;

/**
 * Starts the agent client once the shared key exists. The agent creates the
 * key on its first start, so the API may come up first; until then every
 * call fails fast with AGENT_UNAVAILABLE and the API keeps serving.
 */
export class LazyAgentGateway implements AgentGateway {
  readonly #socketPath: string;
  readonly #keyFile: string;
  readonly #logger: Logger;
  #client: AgentClient | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #warned = false;

  constructor(options: { socketPath: string; keyFile: string; logger: Logger }) {
    this.#socketPath = options.socketPath;
    this.#keyFile = options.keyFile;
    this.#logger = options.logger;
  }

  get state(): AgentConnectionState {
    return this.#client?.state ?? "disconnected";
  }

  start(): void {
    if (this.#client) return;
    try {
      const agentKey = loadKeyFile(this.#keyFile, { create: false, enforcePermissions: true });
      this.#client = new AgentClient({
        socketPath: this.#socketPath,
        agentKey,
        logger: this.#logger,
      });
      this.#client.start();
    } catch (error) {
      if (!this.#warned) {
        this.#warned = true;
        this.#logger.warn("Agent key not available yet; retrying", {
          file: this.#keyFile,
          reason: error instanceof KeyFileError ? error.message : String(error),
        });
      }
      this.#retryTimer = setTimeout(() => this.start(), KEY_RETRY_MS);
      this.#retryTimer.unref();
    }
  }

  stop(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#client?.stop();
  }

  call<N extends OperationName>(
    op: N,
    params: OperationParams<N>,
    actor: Actor,
    options?: { signal?: AbortSignal },
  ): Promise<OperationResult<N>> {
    if (!this.#client)
      return Promise.reject(new AgentClientError("AGENT_UNAVAILABLE", "Agent key not available"));
    return this.#client.call(op, params, actor, options);
  }
}
