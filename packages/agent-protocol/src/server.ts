import { chmodSync, chownSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { silentLogger, type Logger } from "@otuken/logger";
import { roleHasPermission } from "@otuken/shared";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  encodeFrame,
  FrameTooLargeError,
  LineDecoder,
} from "./framing.ts";
import { createNonce, deriveAgentAuthKey, serverProof, verifyClientMac } from "./handshake.ts";
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type Actor,
  type AgentErrorCode,
  type ClientMessage,
  type RequestMessage,
} from "./messages.ts";
import {
  AGENT_OPERATIONS,
  isOperationName,
  type OperationContract,
  type OperationEvent,
  type OperationResult,
  type ParsedOperationParams,
  type StreamContract,
  type StreamOperationName,
  type UnaryContract,
  type UnaryOperationName,
} from "./operations.ts";

/** Error type handlers throw to return a specific code and a safe message. */
export class OperationError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "OperationError";
    this.code = code;
  }
}

export interface OperationContext {
  actor: Actor;
  signal: AbortSignal;
  logger: Logger;
}

export type UnaryHandler<N extends UnaryOperationName> = (
  params: ParsedOperationParams<N>,
  context: OperationContext,
) => Promise<OperationResult<N>> | OperationResult<N>;

/** Stream handlers must stop producing once `context.signal` aborts. */
export type StreamHandler<N extends StreamOperationName> = (
  params: ParsedOperationParams<N>,
  context: OperationContext,
) => AsyncIterable<OperationEvent<N>>;

export type OperationHandlers = { [N in UnaryOperationName]: UnaryHandler<N> } & {
  [N in StreamOperationName]: StreamHandler<N>;
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Extra, operation-specific rules evaluated after the permission check. */
export type OperationPolicy = (op: string, params: unknown, actor: Actor) => PolicyDecision;

export interface AgentServerOptions {
  socketPath: string;
  agentKey: Buffer;
  agentVersion: string;
  handlers: OperationHandlers;
  policy?: OperationPolicy;
  logger?: Logger;
  /** Mode applied to the socket file. */
  socketMode?: number;
  /** Group that may connect (the API's group). Requires the agent to run as root. */
  socketGroupId?: number | null;
  maxConnections?: number;
  maxInFlightPerConnection?: number;
  /** Concurrent stream operations per connection (they also count as in flight). */
  maxStreamsPerConnection?: number;
  handshakeTimeoutMs?: number;
  /** Largest accepted request frame. */
  maxMessageBytes?: number;
  /** Largest frame the agent will send; bigger results fail instead of breaking the connection. */
  maxResponseBytes?: number;
}

interface Connection {
  readonly log: Logger;
  readonly inFlight: Map<number, AbortController>;
  streams: number;
  /** Writes one frame; throws FrameTooLargeError without writing when it exceeds the limit. */
  send(message: unknown): void;
  /** Resolves once the socket's write buffer has drained (or the socket closed). */
  drained(): Promise<void>;
}

export class AgentServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentServerError";
  }
}

function describeActor(actor: Actor): Record<string, unknown> {
  return actor.kind === "user"
    ? {
        actorKind: "user",
        userId: actor.userId,
        username: actor.username,
        role: actor.role,
        ip: actor.ip,
      }
    : { actorKind: "system", component: actor.component };
}

export function isActorAuthorized(contract: OperationContract, actor: Actor): boolean {
  if (actor.kind === "system") return contract.allowSystemActor;
  return contract.permission === null || roleHasPermission(actor.role, contract.permission);
}

async function probeExistingSocket(path: string): Promise<"absent" | "stale" | "live"> {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "absent";
  }
  if (!stat.isSocket()) {
    throw new AgentServerError(`Refusing to replace non-socket file at ${path}`);
  }
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve("live");
    });
    probe.once("error", () => resolve("stale"));
  });
}

/**
 * The agent side of the protocol: accepts authenticated connections, validates
 * every request against the operation registry and dispatches to handlers.
 */
export class AgentServer {
  readonly #options: AgentServerOptions;
  readonly #authKey: Buffer;
  readonly #logger: Logger;
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;

  constructor(options: AgentServerOptions) {
    this.#options = options;
    this.#authKey = deriveAgentAuthKey(options.agentKey);
    this.#logger = (options.logger ?? silentLogger).child({ component: "agent-server" });
  }

  get connectionCount(): number {
    return this.#sockets.size;
  }

  async listen(): Promise<void> {
    const { socketPath } = this.#options;
    const existing = await probeExistingSocket(socketPath);
    if (existing === "live")
      throw new AgentServerError(`Another agent is already listening on ${socketPath}`);
    if (existing === "stale") unlinkSync(socketPath);

    const server = createServer({ allowHalfOpen: false }, (socket) => this.#accept(socket));
    server.maxConnections = this.#options.maxConnections ?? 4;
    this.#server = server;
    const mode = this.#options.socketMode ?? 0o660;
    // Create the socket with restrictive permissions from the start instead of
    // tightening them after it already accepts connections.
    const previousUmask = process.umask(0o777 & ~mode);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousUmask);
    }
    chmodSync(socketPath, mode);
    if (this.#options.socketGroupId !== undefined && this.#options.socketGroupId !== null) {
      chownSync(socketPath, process.getuid?.() ?? 0, this.#options.socketGroupId);
    }
    server.on("error", (error) => this.#logger.error("Agent server error", { error }));
    this.#logger.info("Agent listening", { socketPath, mode: mode.toString(8) });
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    const decoder = new LineDecoder(this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
    const maxInFlight = this.#options.maxInFlightPerConnection ?? 16;
    const maxResponseBytes = this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const serverNonce = createNonce();
    let authenticated = false;

    const connection: Connection = {
      log: this.#logger.child({ connection: this.#sockets.size }),
      inFlight: new Map(),
      streams: 0,
      send(message) {
        if (socket.destroyed) return;
        const frame = encodeFrame(message);
        if (Buffer.byteLength(frame) > maxResponseBytes)
          throw new FrameTooLargeError(maxResponseBytes);
        socket.write(frame);
      },
      drained() {
        if (!socket.writableNeedDrain || socket.destroyed) return Promise.resolve();
        return new Promise((resolve) => {
          const done = () => {
            socket.off("drain", done);
            socket.off("close", done);
            resolve();
          };
          socket.once("drain", done);
          socket.once("close", done);
        });
      },
    };
    const { log, inFlight } = connection;
    const send = (message: unknown) => connection.send(message);
    const fatal = (code: AgentErrorCode, message: string) => {
      send({ type: "fatal", code, message });
      socket.end();
      socket.destroySoon();
    };

    const handshakeTimer = setTimeout(() => {
      log.warn("Client did not authenticate in time");
      fatal("invalid_request", "Handshake timeout");
    }, this.#options.handshakeTimeoutMs ?? 5_000);

    send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      agentVersion: this.#options.agentVersion,
      nonce: serverNonce,
    });

    const onMessage = (message: ClientMessage) => {
      if (!authenticated) {
        if (message.type !== "auth") return fatal("invalid_request", "Authentication required");
        if (message.protocol !== PROTOCOL_VERSION)
          return fatal("invalid_request", "Unsupported protocol version");
        if (!verifyClientMac(this.#authKey, serverNonce, message.clientNonce, message.mac)) {
          log.warn("Rejected client with invalid credentials");
          return fatal("forbidden", "Authentication failed");
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        send({
          type: "ready",
          proof: serverProof(this.#authKey, serverNonce, message.clientNonce),
        });
        log.debug("Client authenticated");
        return;
      }
      switch (message.type) {
        case "auth":
          return fatal("invalid_request", "Already authenticated");
        case "cancel":
          inFlight.get(message.id)?.abort(new OperationError("cancelled", "Cancelled by client"));
          return;
        case "request":
          if (inFlight.has(message.id)) {
            send({
              type: "response",
              id: message.id,
              ok: false,
              error: { code: "invalid_request", message: "Duplicate request id" },
            });
            return;
          }
          if (inFlight.size >= maxInFlight) {
            send({
              type: "response",
              id: message.id,
              ok: false,
              error: { code: "busy", message: "Too many concurrent requests" },
            });
            return;
          }
          void this.#dispatch(message, connection);
          return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        return fatal("invalid_request", "Message too large");
      }
      for (const line of lines) {
        let message: ClientMessage;
        try {
          message = ClientMessageSchema.parse(JSON.parse(line));
        } catch {
          return fatal("invalid_request", "Malformed message");
        }
        onMessage(message);
      }
    });
    socket.on("error", (error) => log.debug("Client socket error", { message: error.message }));
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      for (const controller of inFlight.values()) {
        controller.abort(new OperationError("cancelled", "Client disconnected"));
      }
      inFlight.clear();
      this.#sockets.delete(socket);
    });
  }

  async #dispatch(message: RequestMessage, connection: Connection): Promise<void> {
    const { id, op, actor } = message;
    const { log, inFlight } = connection;
    const reply = (outcome: { result: unknown } | { code: AgentErrorCode; message: string }) => {
      const error = (code: AgentErrorCode, text: string) =>
        connection.send({ type: "response", id, ok: false, error: { code, message: text } });
      if (!("result" in outcome)) return error(outcome.code, outcome.message);
      try {
        connection.send({ type: "response", id, ok: true, result: outcome.result });
      } catch (sendError) {
        if (!(sendError instanceof FrameTooLargeError)) throw sendError;
        log.error("Operation result exceeds the frame limit", { op, requestId: id });
        error("failed", "Operation result is too large");
      }
    };

    if (!isOperationName(op)) {
      log.warn("Unknown operation requested", { op, ...describeActor(actor) });
      return reply({ code: "unknown_operation", message: `Unknown operation: ${op}` });
    }
    const contract: OperationContract = AGENT_OPERATIONS[op];
    const auditFields = { op, requestId: id, ...describeActor(actor) };

    if (!isActorAuthorized(contract, actor)) {
      log.warn("Operation denied: missing permission", {
        ...auditFields,
        permission: contract.permission,
      });
      return reply({ code: "forbidden", message: "Actor lacks the required permission" });
    }
    const parsed = contract.params.safeParse(message.params);
    if (!parsed.success) {
      log.warn("Operation rejected: invalid parameters", auditFields);
      return reply({ code: "invalid_params", message: "Invalid operation parameters" });
    }
    const decision = this.#options.policy?.(op, parsed.data, actor) ?? { allowed: true };
    if (!decision.allowed) {
      log.warn("Operation denied by policy", { ...auditFields, reason: decision.reason });
      return reply({ code: "policy_denied", message: decision.reason });
    }
    if (
      contract.kind === "stream" &&
      connection.streams >= (this.#options.maxStreamsPerConnection ?? 8)
    ) {
      return reply({ code: "busy", message: "Too many concurrent streams" });
    }

    const controller = new AbortController();
    inFlight.set(id, controller);
    const limitMs = contract.kind === "unary" ? contract.timeoutMs : contract.maxDurationMs;
    const timer = setTimeout(
      () => controller.abort(new OperationError("timeout", `Operation exceeded ${limitMs} ms`)),
      limitMs,
    );
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), {
        once: true,
      });
    });
    aborted.catch(() => undefined);
    if (contract.mutating) log.info("Executing operation", auditFields);
    else log.debug("Executing operation", auditFields);

    const context: OperationContext = {
      actor,
      signal: controller.signal,
      logger: log.child({ op }),
    };
    const handler = this.#options.handlers[op] as (
      params: unknown,
      context: OperationContext,
    ) => unknown;
    try {
      if (contract.kind === "unary") {
        const result = await Promise.race([
          Promise.resolve(handler(parsed.data, context)),
          aborted,
        ]);
        reply({ result: this.#validateResult(contract, result, auditFields, log) });
        if (contract.mutating) log.info("Operation succeeded", auditFields);
      } else {
        connection.streams += 1;
        try {
          await this.#pump(
            contract,
            handler(parsed.data, context) as AsyncIterable<unknown>,
            id,
            connection,
            aborted,
          );
        } finally {
          connection.streams -= 1;
        }
        reply({ result: null });
      }
    } catch (error) {
      if (error instanceof OperationError) {
        // Client-side cancellation is routine; real failures stay visible.
        const level = error.code === "cancelled" ? "debug" : "warn";
        log[level]("Operation failed", {
          ...auditFields,
          code: error.code,
          message: error.message,
        });
        reply({ code: error.code, message: error.message });
      } else {
        log.error("Operation crashed", { ...auditFields, error });
        reply({ code: "failed", message: "Operation failed" });
      }
    } finally {
      clearTimeout(timer);
      inFlight.delete(id);
      // Release the handler (e.g. kill a `journalctl --follow` child) on every exit path.
      if (!controller.signal.aborted)
        controller.abort(new OperationError("cancelled", "Operation finished"));
    }
  }

  #validateResult(
    contract: UnaryContract,
    result: unknown,
    auditFields: Record<string, unknown>,
    log: Logger,
  ): unknown {
    const validated = contract.result.safeParse(result);
    if (validated.success) return validated.data;
    log.error("Handler returned a result that violates the contract", auditFields);
    throw new OperationError("failed", "Agent produced an invalid result");
  }

  /** Forwards stream events, pausing while the socket applies backpressure. */
  async #pump(
    contract: StreamContract,
    events: AsyncIterable<unknown>,
    id: number,
    connection: Connection,
    aborted: Promise<never>,
  ): Promise<void> {
    const iterator = events[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) return;
        const validated = contract.event.safeParse(next.value);
        if (!validated.success) {
          connection.log.error("Stream produced an event that violates the contract", { id });
          throw new OperationError("failed", "Agent produced an invalid event");
        }
        try {
          connection.send({ type: "event", id, data: validated.data });
        } catch (error) {
          if (error instanceof FrameTooLargeError) continue; // Drop the single oversized event.
          throw error;
        }
        await Promise.race([connection.drained(), aborted]);
      }
    } finally {
      // Do not await: a generator blocked in `next()` finishes once the signal aborts.
      void iterator.return?.()?.catch(() => undefined);
    }
  }
}
