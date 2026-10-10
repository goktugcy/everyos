import { chmodSync, chownSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { silentLogger, type Logger } from "@otuken/logger";
import { roleHasPermission } from "@otuken/shared";
import type { z } from "zod";
import { DEFAULT_MAX_MESSAGE_BYTES, encodeFrame, LineDecoder } from "./framing.ts";
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
  type AgentOperations,
  type OperationContract,
  type OperationName,
  type OperationResult,
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

export type OperationHandler<N extends OperationName> = (
  params: z.output<AgentOperations[N]["params"]>,
  context: OperationContext,
) => Promise<OperationResult<N>> | OperationResult<N>;

export type OperationHandlers = { [N in OperationName]: OperationHandler<N> };

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Extra, operation-specific rules evaluated after the permission check. */
export type OperationPolicy = (op: OperationName, params: unknown, actor: Actor) => PolicyDecision;

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
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
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
    const log = this.#logger.child({ connection: this.#sockets.size });
    const decoder = new LineDecoder(this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
    const maxInFlight = this.#options.maxInFlightPerConnection ?? 16;
    const inFlight = new Map<number, AbortController>();
    const serverNonce = createNonce();
    let authenticated = false;

    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(encodeFrame(message));
    };
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
          void this.#dispatch(message, inFlight, send, log);
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

  async #dispatch(
    message: RequestMessage,
    inFlight: Map<number, AbortController>,
    send: (message: unknown) => void,
    log: Logger,
  ): Promise<void> {
    const { id, op, actor } = message;
    const reply = (outcome: { result: unknown } | { code: AgentErrorCode; message: string }) => {
      if ("result" in outcome) send({ type: "response", id, ok: true, result: outcome.result });
      else
        send({
          type: "response",
          id,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        });
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

    const controller = new AbortController();
    inFlight.set(id, controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          new OperationError("timeout", `Operation exceeded ${contract.timeoutMs} ms`),
        ),
      contract.timeoutMs,
    );
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), {
        once: true,
      });
    });
    aborted.catch(() => undefined);
    if (contract.mutating) log.info("Executing operation", auditFields);
    else log.debug("Executing operation", auditFields);

    const handler = this.#options.handlers[op] as OperationHandler<OperationName>;
    try {
      const result = await Promise.race([
        Promise.resolve(
          handler(parsed.data as never, {
            actor,
            signal: controller.signal,
            logger: log.child({ op }),
          }),
        ),
        aborted,
      ]);
      const validated = contract.result.safeParse(result);
      if (!validated.success) {
        log.error("Handler returned a result that violates the contract", auditFields);
        reply({ code: "failed", message: "Agent produced an invalid result" });
      } else {
        if (contract.mutating) log.info("Operation succeeded", auditFields);
        reply({ result: validated.data });
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
    }
  }
}
