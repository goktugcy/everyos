import type { TerminalClientMessage, TerminalStatus } from "@everyos/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import {
  closeReason,
  inputFrames,
  readSession,
  reconnectDelay,
  saveSession,
  serverMessage,
  terminalUrl,
  type EndReason,
} from "./helpers.ts";

export type ConnectionState =
  | { phase: "connecting" | "reconnecting" }
  | { phase: "connected"; account: string; shell: string; resumed: boolean }
  | { phase: "ended"; reason: EndReason; code: number | null };

interface Options {
  key: string;
  size: () => { cols: number; rows: number };
  state: (state: ConnectionState) => void;
  output: (bytes: Uint8Array) => void;
  reset: () => void;
}

/** One socket per window; a retry never silently starts another shell. */
export class TerminalConnection {
  readonly #options: Options;
  #id: string | null;
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #probe: AbortController | null = null;
  #disposed = false;
  #endOnDispose = false;
  #ended = false;
  #ready = false;
  #attempt = 0;
  #droppedAt: number | null = null;
  #termination: Promise<void> | null = null;

  constructor(options: Options) {
    this.#options = options;
    this.#id = readSession(options.key);
  }

  start(): void {
    this.#connect();
  }

  input(data: string): void {
    if (!this.#ready || this.#disposed || this.#socket?.readyState !== WebSocket.OPEN) return;
    for (const frame of inputFrames(data)) this.#socket.send(frame);
  }

  resize(size: TerminalClientMessage): void {
    if (this.#ready && !this.#disposed && this.#socket?.readyState === WebSocket.OPEN)
      this.#socket.send(JSON.stringify(size));
  }

  dispose(end: boolean): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#endOnDispose = end;
    clearTimeout(this.#timer);
    clearTimeout(this.#deadline);
    this.#probe?.abort();
    if (end && this.#id) this.#terminate(this.#id);
    this.#socket?.close(end ? 4000 : 1000);
  }

  end(): Promise<void> {
    this.dispose(true);
    return this.#termination ?? Promise.resolve();
  }

  #terminate(id: string): void {
    saveSession(this.#options.key, null);
    this.#termination = api<void>(`/terminal/sessions/${id}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => undefined);
  }

  #finish(reason: EndReason, code: number | null = null): void {
    this.#ended = true;
    this.#ready = false;
    clearTimeout(this.#timer);
    clearTimeout(this.#deadline);
    this.#probe?.abort();
    saveSession(this.#options.key, null);
    this.#id = null;
    this.#options.state({ phase: "ended", reason, code });
    this.#socket?.close();
  }

  #connect(): void {
    if (this.#disposed || this.#ended) return;
    this.#options.state({ phase: this.#droppedAt === null ? "connecting" : "reconnecting" });
    const { cols, rows } = this.#options.size();
    const socket = new WebSocket(terminalUrl(location.origin, cols, rows, this.#id));
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#timer = setTimeout(() => socket.close(), 8_000);
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (socket !== this.#socket) return;
      if (typeof event.data === "string") {
        const message = serverMessage(event.data);
        if (!message) {
          if (!this.#disposed) this.#finish("error");
          return;
        }
        if (this.#disposed) {
          // A queued ready frame can arrive while a window's socket is closing.
          if (message.type === "ready" && this.#endOnDispose) this.#terminate(message.sessionId);
          return;
        }
        if (message.type === "exit") {
          this.#finish(message.reason, message.code);
          return;
        }
        this.#id = message.sessionId;
        saveSession(this.#options.key, this.#id);
        this.#ready = true;
        clearTimeout(this.#timer);
        clearTimeout(this.#deadline);
        this.#attempt = 0;
        this.#droppedAt = null;
        // Reattach replays the server's buffer; clear local output to avoid duplicates.
        this.#options.reset();
        this.#options.state({ phase: "connected", ...message });
      } else if (!this.#disposed && event.data instanceof ArrayBuffer) {
        this.#options.output(new Uint8Array(event.data));
      }
    };
    socket.onclose = (event) => {
      socket.onmessage = null;
      socket.onclose = null;
      if (socket !== this.#socket || this.#disposed || this.#ended) return;
      clearTimeout(this.#timer);
      this.#socket = null;
      this.#ready = false;
      const reason = closeReason(event.code);
      if (reason) this.#finish(reason);
      else this.#retry();
    };
  }

  #retry(): void {
    if (this.#disposed || this.#ended) return;
    if (this.#droppedAt === null) {
      this.#droppedAt = Date.now();
      this.#deadline = setTimeout(() => this.#finish("reconnect-timeout"), 55_000);
    }
    const delay = reconnectDelay(this.#attempt++);
    if (Date.now() - this.#droppedAt + delay >= 55_000) {
      this.#finish("reconnect-timeout");
      return;
    }
    this.#options.state({ phase: "reconnecting" });
    this.#timer = setTimeout(() => void this.#reconnect(), delay);
  }

  async #reconnect(): Promise<void> {
    this.#probe = new AbortController();
    try {
      // Upgrade failures have no readable HTTP status in browsers. Probe through
      // the normal client so expired, locked or demoted sessions stop retries.
      const status = await api<TerminalStatus>("/terminal/status", { signal: this.#probe.signal });
      if (this.#disposed || this.#ended) return;
      if (!status.enabled) this.#finish("disabled");
      else this.#connect();
    } catch (error) {
      if (this.#disposed || this.#ended) return;
      if (error instanceof ApiRequestError && [401, 403, 423].includes(error.status))
        this.#finish("revoked");
      else this.#retry();
    }
  }
}
