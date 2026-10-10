import { connect, type Socket } from "node:net";
import { silentLogger, type Logger } from "@otuken/logger";
import { DEFAULT_MAX_RESPONSE_BYTES, encodeFrame, LineDecoder } from "./framing.ts";
import { clientMac, createNonce, deriveAgentAuthKey, verifyServerProof } from "./handshake.ts";
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type Actor,
  type AgentErrorCode,
  type ServerMessage,
} from "./messages.ts";
import {
  AGENT_OPERATIONS,
  type OperationEvent,
  type OperationParams,
  type OperationResult,
  type StreamContract,
  type StreamOperationName,
  type UnaryContract,
  type UnaryOperationName,
} from "./operations.ts";

export type AgentClientErrorCode =
  | "AGENT_UNAVAILABLE"
  | "AGENT_TIMEOUT"
  | "AGENT_OPERATION_DENIED"
  | "AGENT_OPERATION_FAILED"
  | "AGENT_INVALID_RESPONSE";

export class AgentClientError extends Error {
  readonly code: AgentClientErrorCode;
  readonly agentCode: AgentErrorCode | null;

  constructor(
    code: AgentClientErrorCode,
    message: string,
    agentCode: AgentErrorCode | null = null,
  ) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;
    this.agentCode = agentCode;
  }
}

export type AgentConnectionState = "disconnected" | "connecting" | "connected";

export interface AgentClientOptions {
  socketPath: string;
  /** Raw shared agent key (the handshake key is derived from it). */
  agentKey: Buffer;
  logger?: Logger;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
  /** Events buffered per stream before a slow consumer is disconnected from it. */
  maxQueuedEvents?: number;
}

interface PendingCall {
  op: UnaryOperationName;
  resolve: (value: unknown) => void;
  reject: (error: AgentClientError) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

interface OpenStream {
  op: StreamOperationName;
  push: (event: unknown) => void;
  end: (outcome: AgentClientError | null) => void;
}

function mapAgentError(code: AgentErrorCode, message: string): AgentClientError {
  switch (code) {
    case "forbidden":
    case "policy_denied":
      return new AgentClientError("AGENT_OPERATION_DENIED", message, code);
    case "timeout":
      return new AgentClientError("AGENT_TIMEOUT", message, code);
    case "busy":
      return new AgentClientError("AGENT_UNAVAILABLE", message, code);
    case "invalid_request":
    case "unknown_operation":
    case "invalid_params":
    case "not_found":
    case "unsupported":
    case "conflict":
    case "cancelled":
    case "failed":
      return new AgentClientError("AGENT_OPERATION_FAILED", message, code);
  }
}

/**
 * Long-lived, self-healing connection from the API to the agent. Calls fail
 * fast with AGENT_UNAVAILABLE while disconnected instead of queueing, so the
 * UI can reflect the real state immediately.
 */
export class AgentClient {
  readonly #options: Required<Omit<AgentClientOptions, "logger">>;
  readonly #authKey: Buffer;
  readonly #logger: Logger;
  readonly #pending = new Map<number, PendingCall>();
  readonly #streams = new Map<number, OpenStream>();
  readonly #listeners = new Set<(state: AgentConnectionState) => void>();
  #socket: Socket | null = null;
  #state: AgentConnectionState = "disconnected";
  #nextId = 1;
  #stopped = true;
  #reconnectDelay: number;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #agentVersion: string | null = null;

  constructor(options: AgentClientOptions) {
    this.#options = {
      socketPath: options.socketPath,
      agentKey: options.agentKey,
      reconnectMinDelayMs: options.reconnectMinDelayMs ?? 500,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 15_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      maxQueuedEvents: options.maxQueuedEvents ?? 2_000,
    };
    this.#authKey = deriveAgentAuthKey(options.agentKey);
    this.#logger = (options.logger ?? silentLogger).child({ component: "agent-client" });
    this.#reconnectDelay = this.#options.reconnectMinDelayMs;
  }

  get state(): AgentConnectionState {
    return this.#state;
  }

  get agentVersion(): string | null {
    return this.#agentVersion;
  }

  onStateChange(listener: (state: AgentConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#failAll(new AgentClientError("AGENT_UNAVAILABLE", "Agent client stopped"));
    this.#setState("disconnected");
  }

  /** Resolves once connected, or rejects after `timeoutMs`. */
  waitUntilConnected(timeoutMs = 5_000): Promise<void> {
    if (this.#state === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new AgentClientError("AGENT_UNAVAILABLE", "Timed out waiting for agent connection"));
      }, timeoutMs);
      const unsubscribe = this.onStateChange((state) => {
        if (state === "connected") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  call<N extends UnaryOperationName>(
    op: N,
    params: OperationParams<N>,
    actor: Actor,
    options: { signal?: AbortSignal } = {},
  ): Promise<OperationResult<N>> {
    const socket = this.#socket;
    if (this.#state !== "connected" || !socket) {
      return Promise.reject(new AgentClientError("AGENT_UNAVAILABLE", "Agent is not connected"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new AgentClientError("AGENT_OPERATION_FAILED", "Request aborted"));
    }
    const contract: UnaryContract = AGENT_OPERATIONS[op];
    const id = this.#nextId++;
    return new Promise<OperationResult<N>>((resolve, reject) => {
      const onAbort = () => {
        this.#send({ type: "cancel", id });
        this.#settle(id, new AgentClientError("AGENT_OPERATION_FAILED", "Request aborted"));
      };
      const timer = setTimeout(() => {
        this.#send({ type: "cancel", id });
        this.#settle(id, new AgentClientError("AGENT_TIMEOUT", `Agent operation ${op} timed out`));
      }, contract.timeoutMs + 1_000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        op,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort),
      });
      this.#send({ type: "request", id, op, params, actor });
    });
  }

  /**
   * Runs a stream operation. Iteration ends when the agent finishes the
   * stream, and throws if it fails; breaking out of the loop or aborting
   * `signal` cancels it on the agent.
   */
  async *stream<N extends StreamOperationName>(
    op: N,
    params: OperationParams<N>,
    actor: Actor,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<OperationEvent<N>, void, undefined> {
    if (this.#state !== "connected" || !this.#socket) {
      throw new AgentClientError("AGENT_UNAVAILABLE", "Agent is not connected");
    }
    const { signal } = options;
    if (signal?.aborted) return;
    const contract: StreamContract = AGENT_OPERATIONS[op];
    const id = this.#nextId++;
    const queue: unknown[] = [];
    let ended: { error: AgentClientError | null } | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const end = (error: AgentClientError | null) => {
      if (ended) return;
      ended = { error };
      this.#streams.delete(id);
      notify();
    };
    this.#streams.set(id, {
      op,
      push: (event) => {
        const parsed = contract.event.safeParse(event);
        if (!parsed.success) {
          this.#send({ type: "cancel", id });
          end(new AgentClientError("AGENT_INVALID_RESPONSE", `Agent sent an invalid ${op} event`));
        } else if (queue.length >= this.#options.maxQueuedEvents) {
          this.#send({ type: "cancel", id });
          end(new AgentClientError("AGENT_OPERATION_FAILED", `Consumer of ${op} is too slow`));
        } else {
          queue.push(parsed.data);
          notify();
        }
      },
      end,
    });
    signal?.addEventListener("abort", notify);
    this.#send({ type: "request", id, op, params, actor });
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as OperationEvent<N>;
          continue;
        }
        const finished = ended as { error: AgentClientError | null } | null;
        if (finished) {
          if (finished.error) throw finished.error;
          return;
        }
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", notify);
      if (this.#streams.has(id)) {
        this.#streams.delete(id);
        this.#send({ type: "cancel", id });
      }
    }
  }

  #setState(state: AgentConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch (error) {
        this.#logger.error("Agent state listener failed", { error });
      }
    }
  }

  #send(message: unknown): void {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return;
    socket.write(encodeFrame(message));
  }

  #settle(id: number, outcome: AgentClientError | { value: unknown }): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (outcome instanceof AgentClientError) pending.reject(outcome);
    else pending.resolve(outcome.value);
  }

  #failAll(error: AgentClientError): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, error);
    for (const stream of [...this.#streams.values()]) stream.end(error);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, this.#options.reconnectMaxDelayMs);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#setState("connecting");
    const socket = connect(this.#options.socketPath);
    this.#socket = socket;
    const decoder = new LineDecoder(this.#options.maxMessageBytes);
    const clientNonce = createNonce();
    let serverNonce: string | null = null;
    let authenticated = false;

    const handshakeTimer = setTimeout(() => {
      this.#logger.warn("Agent handshake timed out");
      socket.destroy();
    }, this.#options.handshakeTimeoutMs);

    const handle = (message: ServerMessage): void => {
      switch (message.type) {
        case "hello":
          if (message.protocol !== PROTOCOL_VERSION) {
            this.#logger.error("Agent protocol version mismatch", {
              agent: message.protocol,
              api: PROTOCOL_VERSION,
            });
            socket.destroy();
            return;
          }
          serverNonce = message.nonce;
          this.#agentVersion = message.agentVersion;
          this.#send({
            type: "auth",
            protocol: PROTOCOL_VERSION,
            clientNonce,
            mac: clientMac(this.#authKey, message.nonce, clientNonce),
          });
          return;
        case "ready":
          if (
            !serverNonce ||
            !verifyServerProof(this.#authKey, serverNonce, clientNonce, message.proof)
          ) {
            this.#logger.error("Agent failed to prove its identity; closing connection");
            socket.destroy();
            return;
          }
          clearTimeout(handshakeTimer);
          authenticated = true;
          this.#reconnectDelay = this.#options.reconnectMinDelayMs;
          this.#logger.info("Connected to agent", { agentVersion: this.#agentVersion });
          this.#setState("connected");
          return;
        case "event":
          if (authenticated) this.#streams.get(message.id)?.push(message.data);
          return;
        case "response": {
          if (!authenticated) return;
          const stream = this.#streams.get(message.id);
          if (stream) {
            stream.end(
              message.ok ? null : mapAgentError(message.error.code, message.error.message),
            );
            return;
          }
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          if (!message.ok) {
            this.#settle(message.id, mapAgentError(message.error.code, message.error.message));
            return;
          }
          const contract: UnaryContract = AGENT_OPERATIONS[pending.op];
          const parsed = contract.result.safeParse(message.result);
          this.#settle(
            message.id,
            parsed.success
              ? { value: parsed.data }
              : new AgentClientError(
                  "AGENT_INVALID_RESPONSE",
                  `Agent returned an invalid ${pending.op} result`,
                ),
          );
          return;
        }
        case "fatal":
          this.#logger.error("Agent closed the connection", {
            code: message.code,
            message: message.message,
          });
          socket.destroy();
          return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        this.#logger.error("Invalid frame from agent", { error });
        socket.destroy();
        return;
      }
      for (const line of lines) {
        let parsed: ServerMessage;
        try {
          parsed = ServerMessageSchema.parse(JSON.parse(line));
        } catch {
          this.#logger.error("Malformed message from agent; closing connection");
          socket.destroy();
          return;
        }
        handle(parsed);
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      // ENOENT/ECONNREFUSED are expected while the agent is not running.
      const level = error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "debug" : "warn";
      this.#logger[level]("Agent socket error", { code: error.code, message: error.message });
    });

    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (this.#socket === socket) this.#socket = null;
      this.#failAll(new AgentClientError("AGENT_UNAVAILABLE", "Agent connection closed"));
      if (this.#state === "connected") this.#logger.warn("Agent connection lost");
      this.#setState("disconnected");
      this.#scheduleReconnect();
    });
  }
}
