import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCsrfToken } from "../../../lib/api.ts";
import { TerminalConnection } from "./connection.ts";

const id = "8b2fd8b1-62ef-4ad4-a1cd-8d430e0d055f";
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  url: string;
  readyState = 1;
  binaryType = "";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    Socket.instances.push(this);
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
let storage: Map<string, string>;
const request = vi.fn<typeof fetch>();
function setup() {
  const state = vi.fn();
  const output = vi.fn();
  const reset = vi.fn();
  const connection = new TerminalConnection({
    key: "window",
    size: () => ({ cols: 80, rows: 24 }),
    state,
    output,
    reset,
  });
  connection.start();
  const socket = Socket.instances.at(-1)!;
  const ready = () =>
    socket.message(
      JSON.stringify({
        type: "ready",
        sessionId: id,
        account: "regular",
        shell: "/bin/sh",
        resumed: false,
      }),
    );
  return { connection, socket, state, output, reset, ready };
}
beforeEach(() => {
  vi.useFakeTimers();
  storage = new Map();
  Socket.instances = [];
  request.mockReset();
  request.mockResolvedValue(
    new Response(JSON.stringify({ enabled: true, user: "regular", shell: "/bin/sh" }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://otuken.example" });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  setCsrfToken("test-csrf");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

it("persists ready, sends bounded binary input, resizes with text and renders bytes", () => {
  const { connection, socket, ready, output, reset } = setup();
  connection.input("ignored");
  expect(socket.send).not.toHaveBeenCalled();
  ready();
  expect(storage.get("window")).toBe(id);
  connection.input("echo ğ\r");
  expect(socket.send.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
  connection.resize({ type: "resize", cols: 90, rows: 25 });
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"resize","cols":90,"rows":25}');
  const bytes = new TextEncoder().encode("ğ");
  socket.message(bytes.buffer);
  expect(output).toHaveBeenCalledExactlyOnceWith(bytes);
  expect(reset).toHaveBeenCalledOnce();
  connection.dispose(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("resumes the same shell after a drop and resets replay without opening a new one", async () => {
  const { connection, socket, ready, reset } = setup();
  ready();
  socket.drop(1006);
  connection.input("ignored");
  await vi.advanceTimersByTimeAsync(500);
  const next = Socket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  expect(new URL(next.url).searchParams.get("session")).toBe(id);
  next.message(
    JSON.stringify({
      type: "ready",
      sessionId: id,
      account: "regular",
      shell: "/bin/sh",
      resumed: true,
    }),
  );
  expect(reset).toHaveBeenCalledTimes(2);
  connection.dispose(false);
  expect(storage.get("window")).toBe(id);
  expect(
    request.mock.calls.some(([path]) => typeof path === "string" && path.includes("/sessions/")),
  ).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([4000, 4403, 4404, 4409, 4429])(
  "stops after final close %s and clears the reload id",
  async (code) => {
    const { connection, socket, state, ready } = setup();
    ready();
    socket.drop(code);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(storage.has("window")).toBe(false);
    expect(state.mock.lastCall?.[0].phase).toBe("ended");
    connection.dispose(true);
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(["exited", "idle", "closed", "revoked", "error"])(
  "never retries after exit reason %s",
  async (reason) => {
    const { connection, socket, state, ready } = setup();
    ready();
    socket.message(JSON.stringify({ type: "exit", reason, code: 7 }));
    socket.drop(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state).toHaveBeenLastCalledWith({ phase: "ended", reason, code: 7 });
    expect(Socket.instances).toHaveLength(1);
    connection.dispose(true);
  },
);

it("deletes immediately on window close with CSRF and keepalive and cancels retries", async () => {
  const { connection, socket, ready } = setup();
  ready();
  socket.drop(1006);
  await connection.end();
  expect(request).toHaveBeenCalledWith(
    `/api/terminal/sessions/${id}`,
    expect.objectContaining({
      method: "DELETE",
      keepalive: true,
      headers: expect.objectContaining({ "x-otuken-csrf": "test-csrf" }),
    }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(Socket.instances).toHaveLength(1);
  expect(storage.has("window")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("deletes a late ready session when the window closed during attachment", () => {
  const { connection, ready } = setup();
  connection.dispose(true);
  expect(Socket.instances[0]!.close).toHaveBeenCalledWith(4000);
  ready();
  expect(request).toHaveBeenCalledWith(
    `/api/terminal/sessions/${id}`,
    expect.objectContaining({ method: "DELETE", keepalive: true }),
  );
});

it("ends retries before grace expiry and cannot retry a permission denial", async () => {
  const { connection, socket, ready, state } = setup();
  ready();
  socket.drop(1006);
  request.mockImplementation(() =>
    Promise.resolve(
      new Response('{"error":{"code":"FORBIDDEN","message":"denied"}}', { status: 403 }),
    ),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state).toHaveBeenLastCalledWith({ phase: "ended", reason: "revoked", code: null });
  expect(Socket.instances).toHaveLength(1);
  connection.dispose(false);
});

it("bounds offline retries to the reconnect grace and clears timers", async () => {
  const { connection, socket, ready, state } = setup();
  ready();
  socket.drop(1006);
  request.mockRejectedValue(new TypeError("offline"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state).toHaveBeenLastCalledWith({
    phase: "ended",
    reason: "reconnect-timeout",
    code: null,
  });
  expect(vi.getTimerCount()).toBe(0);
  connection.dispose(false);
});

it("ends within grace even when the HTTP reconnect probe never responds", async () => {
  const { connection, socket, ready, state } = setup();
  ready();
  socket.drop(1006);
  request.mockImplementation(() => new Promise(() => undefined));
  await vi.advanceTimersByTimeAsync(55_000);
  expect(state).toHaveBeenLastCalledWith({
    phase: "ended",
    reason: "reconnect-timeout",
    code: null,
  });
  expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  connection.dispose(false);
});
