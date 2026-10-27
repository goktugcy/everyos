import {
  BRIDGE_ERRORS,
  type ErrorPayload,
  type EventName,
  type Events,
  type HelloMessage,
  type Method,
  type Params,
  type Result,
} from "@everyos/app-sdk/protocol";
import { ApiRequestError } from "../../lib/api.ts";
import { isRecord, VALIDATORS } from "./validate.ts";

export type Handler<M extends Method> = (params: Params<M>) => Promise<Result<M>> | Result<M>;
export type Handlers = { [M in Method]?: Handler<M> };

/** A bridge-level refusal (the app sees `code`). */
export class BridgeRefusal extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const RATE_PER_SECOND = 60;
const BURST = 240;
const MAX_IN_FLIGHT = 32;
/** Malformed messages tolerated before the app is considered hostile and stopped. */
const MAX_DROPPED = 64;

function payloadOf(error: unknown): ErrorPayload {
  if (error instanceof BridgeRefusal)
    return { code: error.code, message: error.message, details: error.details };
  if (error instanceof ApiRequestError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  return { code: "INTERNAL_ERROR", message: "The request failed" };
}

/**
 * The desktop end of one app instance's port. Every message is checked (envelope, method, params,
 * rate, concurrency) before its handler runs; handlers only exist for what this instance may do.
 */
export class AppBridge {
  readonly #port: MessagePort;
  readonly #handlers: Handlers;
  readonly #onAbuse: () => void;
  readonly #now: () => number;
  #tokens = BURST;
  #last: number;
  #inFlight = 0;
  #dropped = 0;
  #closed = false;

  constructor(
    port: MessagePort,
    handlers: Handlers,
    onAbuse: () => void,
    now: () => number = () => performance.now(),
  ) {
    this.#port = port;
    this.#handlers = handlers;
    this.#onAbuse = onAbuse;
    this.#now = now;
    this.#last = now();
  }

  start(hello: HelloMessage): void {
    this.#port.onmessage = (event: MessageEvent) => this.#receive(event.data);
    this.#port.onmessageerror = () => this.#drop();
    this.#port.start();
    this.#port.postMessage(hello);
  }

  emit<E extends EventName>(event: E, data: Events[E]): void {
    if (!this.#closed) this.#port.postMessage({ kind: "event", event, data });
  }

  close(): void {
    this.#closed = true;
    this.#port.onmessage = null;
    this.#port.close();
  }

  #drop(): void {
    if (++this.#dropped > MAX_DROPPED && !this.#closed) {
      this.close();
      this.#onAbuse();
    }
  }

  #take(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(BURST, this.#tokens + ((now - this.#last) / 1000) * RATE_PER_SECOND);
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #respond(
    id: number,
    outcome: { ok: true; result: unknown } | { ok: false; error: ErrorPayload },
  ) {
    if (this.#closed) return;
    const transfer =
      outcome.ok && isRecord(outcome.result) && outcome.result.data instanceof ArrayBuffer
        ? [outcome.result.data]
        : [];
    this.#port.postMessage({ kind: "response", id, ...outcome }, transfer);
  }

  #receive(message: unknown): void {
    if (this.#closed) return;
    if (
      !isRecord(message) ||
      message.kind !== "request" ||
      !Number.isSafeInteger(message.id) ||
      typeof message.method !== "string"
    ) {
      this.#drop();
      return;
    }
    const id = message.id as number;
    const method = message.method;
    const fail = (code: string, text: string) =>
      this.#respond(id, { ok: false, error: { code, message: text } });
    if (!Object.hasOwn(VALIDATORS, method)) {
      this.#drop();
      fail(BRIDGE_ERRORS.unknownMethod, `Unknown method ${method.slice(0, 64)}`);
      return;
    }
    const params = message.params ?? null;
    if (!VALIDATORS[method as Method](params)) {
      this.#drop();
      fail(BRIDGE_ERRORS.invalid, `Invalid parameters for ${method}`);
      return;
    }
    if (!this.#take() || this.#inFlight >= MAX_IN_FLIGHT) {
      fail(BRIDGE_ERRORS.rateLimited, "Too many requests");
      return;
    }
    const handler = this.#handlers[method as Method] as Handler<Method> | undefined;
    if (!handler) {
      fail(BRIDGE_ERRORS.unknownMethod, `${method} is not available here`);
      return;
    }
    this.#inFlight += 1;
    void Promise.resolve()
      .then(() => handler(params as Params<Method>))
      .then(
        (result) => this.#respond(id, { ok: true, result: result ?? null }),
        (error: unknown) => this.#respond(id, { ok: false, error: payloadOf(error) }),
      )
      .finally(() => (this.#inFlight -= 1));
  }
}
