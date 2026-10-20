import type { HelloMessage, ResponseMessage } from "@everyos/app-sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../lib/api.ts";
import { AppBridge, type Handlers } from "./bridge.ts";
import { isJsonValue, VALIDATORS } from "./validate.ts";

const hello = { kind: "hello" } as unknown as HelloMessage;

function connect(handlers: Handlers, now = () => 0) {
  const channel = new MessageChannel();
  const onAbuse = vi.fn();
  const bridge = new AppBridge(channel.port1, handlers, onAbuse, now);
  const received: unknown[] = [];
  channel.port2.onmessage = (event: MessageEvent) => received.push(event.data);
  bridge.start(hello);
  const send = (message: unknown) => channel.port2.postMessage(message);
  const response = async (id: number) => {
    await vi.waitFor(() =>
      expect(received.some((m) => (m as ResponseMessage).id === id)).toBe(true),
    );
    return received.find((m) => (m as ResponseMessage).id === id) as ResponseMessage;
  };
  return { bridge, send, response, received, onAbuse, close: () => channel.port2.close() };
}

describe("the desktop end of the app bridge", () => {
  it("answers valid requests and refuses unknown methods, bad parameters and missing handlers", async () => {
    const app = connect({
      "storage.get": ({ key }) => ({ value: key.toUpperCase() }),
      "window.getState": () => {
        throw new ApiRequestError(403, "FORBIDDEN", "no", { capability: "x" });
      },
    });
    app.send({ kind: "request", id: 1, method: "storage.get", params: { key: "a" } });
    expect(await app.response(1)).toEqual({
      kind: "response",
      id: 1,
      ok: true,
      result: { value: "A" },
    });
    app.send({ kind: "request", id: 2, method: "shell.exec", params: { command: "id" } });
    expect((await app.response(2)) as unknown).toMatchObject({
      ok: false,
      error: { code: "EVERYOS_UNKNOWN_METHOD" },
    });
    app.send({ kind: "request", id: 3, method: "storage.get", params: { key: "a", extra: 1 } });
    expect((await app.response(3)) as unknown).toMatchObject({
      ok: false,
      error: { code: "EVERYOS_INVALID_REQUEST" },
    });
    app.send({ kind: "request", id: 4, method: "storage.delete", params: { key: "a" } });
    expect((await app.response(4)) as unknown).toMatchObject({
      ok: false,
      error: { code: "EVERYOS_UNKNOWN_METHOD" },
    });
    app.send({ kind: "request", id: 5, method: "window.getState", params: null });
    expect((await app.response(5)) as unknown).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { capability: "x" } },
    });
    app.bridge.close();
    app.close();
  });

  it("stops an app that keeps sending garbage", async () => {
    const app = connect({});
    for (let i = 0; i < 70; i++) app.send(i % 2 ? "garbage" : { kind: "request", id: "x" });
    await vi.waitFor(() => expect(app.onAbuse).toHaveBeenCalledTimes(1));
    app.close();
  });

  it("limits the request rate", async () => {
    const app = connect({ "theme.get": () => ({}) as never });
    for (let id = 1; id <= 260; id++)
      app.send({ kind: "request", id, method: "theme.get", params: null });
    const last = await app.response(260);
    expect(last).toMatchObject({ ok: false, error: { code: "EVERYOS_RATE_LIMITED" } });
    const answered = app.received.filter((m) => (m as ResponseMessage).kind === "response");
    expect(answered.filter((m) => (m as ResponseMessage).ok).length).toBeLessThanOrEqual(240);
    app.bridge.close();
    app.close();
  });
});

describe("request validation", () => {
  it("accepts plain JSON only", () => {
    expect(isJsonValue({ a: [1, "b", null, true, { c: 2 }] })).toBe(true);
    const notJson: Array<[string, unknown]> = [
      ["Map", new Map()],
      ["Date", new Date()],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["typed array", new Uint8Array(1)],
      ["function", () => 1],
    ];
    for (const [label, value] of notJson) expect(isJsonValue(value), label).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(isJsonValue(deep)).toBe(false);
  });

  it("bounds keys, paths, names and sizes", () => {
    expect(VALIDATORS["storage.get"]({ key: "notes/1" })).toBe(true);
    expect(VALIDATORS["storage.get"]({ key: "a\u0000b" })).toBe(false);
    expect(VALIDATORS["storage.get"]({ key: "" })).toBe(false);
    expect(VALIDATORS["storage.set"]({ key: "k", value: "x".repeat(300 * 1024) })).toBe(false);
    expect(VALIDATORS["files.list"]({ handle: "h", path: "a/b" })).toBe(true);
    for (const path of ["../x", "a/../../x", "/etc"])
      expect(VALIDATORS["files.list"]({ handle: "h", path }), path).toBe(false);
    expect(VALIDATORS["files.save"]({ suggestedName: "a/b.txt", accept: [], persist: false })).toBe(
      false,
    );
    expect(
      VALIDATORS["files.write"]({
        handle: "h",
        offset: 0,
        data: new ArrayBuffer(600 * 1024),
        truncate: true,
      }),
    ).toBe(false);
    expect(VALIDATORS["host.call"]({ operation: "system.metrics", input: null })).toBe(true);
    expect(VALIDATORS["host.call"]({ operation: "shell.exec", input: null })).toBe(false);
    expect(VALIDATORS["window.setTitle"]({ title: "x".repeat(121) })).toBe(false);
  });
});
