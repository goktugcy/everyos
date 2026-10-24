import {
  BRIDGE_ERRORS,
  INIT_TYPE,
  PROTOCOL,
  type EventName,
  type Events,
  type HelloMessage,
  type HostMessage,
  type Method,
  type Params,
  type Result,
} from "./protocol.ts";

export class BridgeError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

/** Methods that wait for the person (a dialog or a picker) have no time limit. */
const INTERACTIVE = new Set<Method>([
  "files.open",
  "files.save",
  "dialog.alert",
  "dialog.confirm",
  "dialog.prompt",
]);
const DEFAULT_TIMEOUT_MS = 60_000;

export interface Connection {
  readonly hello: HelloMessage;
  request<M extends Method>(
    method: M,
    params: Params<M>,
    options?: { transfer?: Transferable[]; timeoutMs?: number },
  ): Promise<Result<M>>;
  on<E extends EventName>(event: E, listener: (data: Events[E]) => void): () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Connects to the EveryOS desktop. Only the first `everyos:init` message from the parent window is
 * accepted; after that the private port is the only channel, so nothing else on the page can talk
 * to the app as the desktop.
 */
export function connect(options: { timeoutMs?: number } = {}): Promise<Connection> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || window.parent === window) {
      reject(new BridgeError(BRIDGE_ERRORS.closed, "Not running inside an EveryOS window"));
      return;
    }
    const deadline = setTimeout(() => {
      window.removeEventListener("message", onInit);
      reject(new BridgeError(BRIDGE_ERRORS.timeout, "EveryOS did not connect"));
    }, options.timeoutMs ?? 15_000);

    const onInit = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; protocol?: unknown } | null;
      if (event.source !== window.parent || data?.type !== INIT_TYPE || !event.ports[0]) return;
      window.removeEventListener("message", onInit);
      if (data.protocol !== PROTOCOL) {
        clearTimeout(deadline);
        reject(
          new BridgeError(BRIDGE_ERRORS.invalid, `Unsupported protocol ${String(data.protocol)}`),
        );
        return;
      }
      const port = event.ports[0];
      const pending = new Map<number, Pending>();
      const listeners = new Map<EventName, Set<(data: never) => void>>();
      let nextId = 1;
      let hello: HelloMessage | null = null;

      port.onmessage = (message: MessageEvent<HostMessage>) => {
        const incoming = message.data;
        if (incoming.kind === "hello" && !hello) {
          hello = incoming;
          clearTimeout(deadline);
          resolve(connection);
        } else if (incoming.kind === "response") {
          const entry = pending.get(incoming.id);
          if (!entry) return;
          pending.delete(incoming.id);
          if (entry.timer) clearTimeout(entry.timer);
          if (incoming.ok) entry.resolve(incoming.result);
          else
            entry.reject(
              new BridgeError(incoming.error.code, incoming.error.message, incoming.error.details),
            );
        } else if (incoming.kind === "event") {
          for (const listener of listeners.get(incoming.event) ?? [])
            (listener as (data: unknown) => void)(incoming.data);
        }
      };
      port.start();

      const connection: Connection = {
        get hello() {
          return hello!;
        },
        request(method, params, requestOptions = {}) {
          const id = nextId++;
          return new Promise((resolveRequest, rejectRequest) => {
            const timeoutMs = INTERACTIVE.has(method)
              ? null
              : (requestOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            pending.set(id, {
              resolve: resolveRequest,
              reject: rejectRequest,
              timer:
                timeoutMs === null
                  ? null
                  : setTimeout(() => {
                      pending.delete(id);
                      rejectRequest(new BridgeError(BRIDGE_ERRORS.timeout, `${method} timed out`));
                    }, timeoutMs),
            });
            port.postMessage(
              { kind: "request", id, method, params },
              requestOptions.transfer ?? [],
            );
          });
        },
        on(event, listener) {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
          return () => set.delete(listener);
        },
      };
    };
    window.addEventListener("message", onInit);
  });
}
