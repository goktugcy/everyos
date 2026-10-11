import type { TerminalClientMessage, TerminalServerMessage } from "@otuken/shared";

export type EndReason =
  | "exited"
  | "idle"
  | "closed"
  | "revoked"
  | "error"
  | "disabled"
  | "missing"
  | "elsewhere"
  | "limit"
  | "reconnect-timeout";

const FINAL_CLOSES: Readonly<Record<number, EndReason>> = {
  4000: "closed",
  4403: "disabled",
  4404: "missing",
  4409: "elsewhere",
  4429: "limit",
};

export function closeReason(code: number): EndReason | null {
  return FINAL_CLOSES[code] ?? null;
}

export function reconnectDelay(attempt: number): number {
  return Math.min(5_000, 500 * 2 ** Math.max(0, Math.min(4, attempt)));
}

export function terminalSize(cols: number, rows: number): TerminalClientMessage {
  return {
    type: "resize",
    cols: Math.max(2, Math.min(500, Math.floor(Number.isFinite(cols) ? cols : 80))),
    rows: Math.max(2, Math.min(300, Math.floor(Number.isFinite(rows) ? rows : 24))),
  };
}

export function debounceResize(send: (size: TerminalClientMessage) => void, delay = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(cols: number, rows: number) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        send(terminalSize(cols, rows));
      }, delay);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function terminalUrl(origin: string, cols: number, rows: number, session: string | null) {
  const url = new URL("/api/terminal/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const size = terminalSize(cols, rows);
  url.searchParams.set("cols", String(size.cols));
  url.searchParams.set("rows", String(size.rows));
  if (session) url.searchParams.set("session", session);
  return url.href;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionKey(userId: string, windowId: string): string {
  return `otuken.terminal:${userId}:${windowId}`;
}

export function readSession(key: string): string | null {
  try {
    const id = sessionStorage.getItem(key);
    return id && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function saveSession(key: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch {
    // Reconnection still works in memory when browser storage is unavailable.
  }
}

/** Validate control frames without importing server schemas into the browser. */
export function serverMessage(text: string): TerminalServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (
    message["type"] === "ready" &&
    typeof message["sessionId"] === "string" &&
    UUID.test(message["sessionId"]) &&
    typeof message["account"] === "string" &&
    typeof message["shell"] === "string" &&
    typeof message["resumed"] === "boolean"
  )
    return message as unknown as Extract<TerminalServerMessage, { type: "ready" }>;
  if (
    message["type"] === "exit" &&
    ["exited", "idle", "closed", "revoked", "error"].includes(String(message["reason"])) &&
    (message["code"] === null ||
      (typeof message["code"] === "number" && Number.isInteger(message["code"])))
  )
    return message as unknown as Extract<TerminalServerMessage, { type: "exit" }>;
  return null;
}

export function inputFrames(data: string): Uint8Array<ArrayBuffer>[] {
  const bytes = new TextEncoder().encode(data);
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
    frames.push(bytes.slice(offset, offset + 64 * 1024));
  return frames;
}
