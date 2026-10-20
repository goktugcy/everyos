import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "./i18n.ts";
import type { HelloMessage, RequestMessage } from "./protocol.ts";
import { MAX_CHUNK_BYTES } from "./protocol.ts";

type Listener = (event: { source: unknown; data: unknown; ports: MessagePort[] }) => void;

const parent = { name: "desktop" };
let listeners: Listener[] = [];

beforeEach(() => {
  vi.resetModules();
  listeners = [];
  vi.stubGlobal("window", {
    parent,
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
    removeEventListener: (_type: string, listener: Listener) =>
      (listeners = listeners.filter((entry) => entry !== listener)),
  });
});
afterEach(() => vi.unstubAllGlobals());

const hello: HelloMessage = {
  kind: "hello",
  protocol: 1,
  app: { id: "dev.everyos.notes", version: "1.0.0", name: "Notes" },
  instance: { id: "w1", kind: "window", widgetId: null },
  granted: ["storage:app"],
  locale: "tr",
  theme: {
    scheme: "dark",
    tokens: { "--everyos-accent": "10 132 255" },
    accent: "#0a84ff",
    fontFamily: "Inter",
    reducedMotion: false,
    reducedTransparency: false,
    density: "comfortable",
  },
  window: { visible: true, focused: true, maximized: false, width: 900, height: 650 },
  everyos: { version: "0.2.0", sdk: "1.0.0" },
  state: { draft: 3 },
};

/** Plays the desktop: answers requests with `handle` and can push events. */
function desktop(handle: (request: RequestMessage) => unknown) {
  const channel = new MessageChannel();
  const requests: RequestMessage[] = [];
  channel.port1.on("message", (request: RequestMessage) => {
    requests.push(request);
    try {
      const result = handle(request);
      channel.port1.postMessage({
        kind: "response",
        id: request.id,
        ok: true,
        result: result ?? null,
      });
    } catch (error) {
      channel.port1.postMessage({
        kind: "response",
        id: request.id,
        ok: false,
        error: {
          code: (error as { code?: string }).code ?? "X",
          message: (error as Error).message,
        },
      });
    }
  });
  return {
    requests,
    init(source: unknown = parent) {
      for (const listener of [...listeners])
        listener({ source, data: { type: "everyos:init", protocol: 1 }, ports: [channel.port2] });
      channel.port1.postMessage(hello);
    },
    emit(event: string, data: unknown) {
      channel.port1.postMessage({ kind: "event", event, data });
    },
    close: () => channel.port1.close(),
  };
}

describe("the app bridge", () => {
  it("accepts only the parent's first init, then talks over the private port", async () => {
    const host = desktop((request) =>
      request.method === "storage.get" ? { value: { text: "hi" } } : null,
    );
    const { createApp } = await import("./index.ts");
    const pending = createApp();
    // A message from anything but the parent window is ignored.
    for (const listener of [...listeners])
      listener({
        source: { name: "other" },
        data: { type: "everyos:init", protocol: 1 },
        ports: [],
      });
    host.init();
    const app = await pending;
    expect(listeners).toHaveLength(0);
    expect(app.app.id).toBe("dev.everyos.notes");
    expect(app.window.initialState).toEqual({ draft: 3 });
    expect(await app.storage.get("note")).toEqual({ text: "hi" });
    expect(host.requests.at(-1)).toMatchObject({ method: "storage.get", params: { key: "note" } });
    host.close();
  });

  it("rejects outside EveryOS and maps errors from the desktop", async () => {
    vi.stubGlobal("window", { parent: undefined });
    (globalThis.window as { parent: unknown }).parent = globalThis.window;
    const outside = await import("./index.ts");
    await expect(outside.createApp()).rejects.toMatchObject({ code: "EVERYOS_CLOSED" });

    vi.resetModules();
    vi.stubGlobal("window", {
      parent,
      addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
      removeEventListener: () => undefined,
    });
    const host = desktop(() => {
      throw Object.assign(new Error("denied"), { code: "EVERYOS_PERMISSION_DENIED" });
    });
    const { createApp, isBridgeError } = await import("./index.ts");
    const pending = createApp();
    host.init();
    const app = await pending;
    const error = await app.host.call("system.metrics").catch((caught: unknown) => caught);
    expect(isBridgeError(error, "EVERYOS_PERMISSION_DENIED")).toBe(true);
    host.close();
  });

  it("follows theme, locale and permission events and asks before closing", async () => {
    const host = desktop(() => null);
    const { createApp } = await import("./index.ts");
    const pending = createApp();
    host.init();
    const app = await pending;
    const themes: string[] = [];
    app.theme.onChange((theme) => themes.push(theme.scheme));
    host.emit("theme.changed", { ...hello.theme, scheme: "light" });
    host.emit("locale.changed", { locale: "de" });
    host.emit("permissions.changed", { granted: ["storage:app", "files:pick"] });
    await vi.waitFor(() => expect(app.permissions.has("files:pick")).toBe(true));
    expect(themes).toEqual(["light"]);
    expect(app.theme.current.scheme).toBe("light");
    expect(app.locale.current).toBe("de");

    await app.lifecycle.guardClose(() => false);
    host.emit("lifecycle.beforeClose", { requestId: "c1" });
    await vi.waitFor(() =>
      expect(host.requests.at(-1)).toMatchObject({
        method: "lifecycle.closeDecision",
        params: { requestId: "c1", close: false },
      }),
    );
    host.close();
  });

  it("runs storage migrations once, in order", async () => {
    const stored = new Map<string, unknown>();
    const host = desktop((request) => {
      const params = request.params as { key: string; value?: unknown };
      if (request.method === "storage.get")
        return stored.has(params.key) ? { value: stored.get(params.key) } : null;
      if (request.method === "storage.set") stored.set(params.key, params.value);
      return null;
    });
    const { createApp } = await import("./index.ts");
    const pending = createApp();
    host.init();
    const app = await pending;
    const ran: number[] = [];
    const steps = {
      1: () => Promise.resolve(void ran.push(1)),
      2: () => Promise.resolve(void ran.push(2)),
    };
    expect(await app.storage.migrate(2, steps)).toBe(2);
    expect(await app.storage.migrate(2, steps)).toBe(2);
    expect(ran).toEqual([1, 2]);
    expect(stored.get("__schema")).toBe(2);
    host.close();
  });

  it("reads and writes files in chunks", async () => {
    const file = new Uint8Array(MAX_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    let written = new Uint8Array(0);
    let committed = false;
    const host = desktop((request) => {
      if (request.method === "files.read") {
        const { offset, length } = request.params as { offset: number; length: number };
        const data = file.slice(offset, offset + length);
        return { data: data.buffer, eof: offset + data.length >= file.length };
      }
      if (request.method === "files.write") {
        const { offset, data, done } = request.params as {
          offset: number;
          data: ArrayBuffer;
          done: boolean;
        };
        const next = new Uint8Array(offset + data.byteLength);
        if (offset > 0) next.set(written.subarray(0, offset));
        next.set(new Uint8Array(data), offset);
        written = next;
        if (done) committed = true;
        return { size: written.length };
      }
      return null;
    });
    const { createApp } = await import("./index.ts");
    const pending = createApp();
    host.init();
    const app = await pending;
    expect(Buffer.from(await app.files.read("h1")).equals(Buffer.from(file))).toBe(true);
    expect(host.requests.filter((r) => r.method === "files.read")).toHaveLength(3);
    expect(await app.files.write("h1", file)).toBe(file.length);
    expect(Buffer.from(written).equals(Buffer.from(file))).toBe(true);
    expect(committed).toBe(true);
    expect(host.requests.filter((r) => r.method === "files.write")).toHaveLength(3);
    host.close();
  });
});

describe("app translations", () => {
  it("falls back to English, fills placeholders and picks plural forms per language", async () => {
    const messages: Record<string, Record<string, unknown>> = {
      en: {
        notes: {
          count_one: "{{count}} note",
          count_other: "{{count}} notes",
          title: "Notes",
          only: "English only",
        },
      },
      ru: {
        notes: {
          count_one: "{{count}} заметка",
          count_few: "{{count}} заметки",
          count_many: "{{count}} заметок",
          count_other: "{{count}} заметки",
          title: "Заметки",
        },
      },
    };
    const i18n = await createI18n({
      locale: "ru",
      supported: ["en", "ru"],
      load: (locale) => messages[locale] as never,
    });
    expect(i18n.t("notes.title")).toBe("Заметки");
    expect(i18n.t("notes.only")).toBe("English only");
    expect(i18n.t("notes.count", { count: 21 })).toBe("21 заметка");
    expect(i18n.t("notes.count", { count: 3 })).toBe("3 заметки");
    expect(i18n.t("notes.count", { count: 5 })).toBe("5 заметок");
    expect(i18n.t("missing.key")).toBe("missing.key");
    await i18n.setLocale("ja");
    expect(i18n.locale).toBe("en");
    expect(i18n.t("notes.count", { count: 1 })).toBe("1 note");
  });
});
