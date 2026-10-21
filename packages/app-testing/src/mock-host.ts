import {
  BRIDGE_ERRORS,
  HOST_OPERATION_CAPABILITY,
  MAX_CHUNK_BYTES,
  MAX_STORAGE_VALUE_BYTES,
  PROTOCOL,
  SDK_VERSION,
  type AppearanceImage,
  type AppearanceState,
  type DirectoryEntry,
  type EventName,
  type Events,
  type FileHandle,
  type FolderIconChoice,
  type HelloMessage,
  type HostOperation,
  type Method,
  type Params,
  type RequestMessage,
  type ThemeSnapshot,
  type WallpaperChoice,
  type WindowState,
} from "@everyos/app-sdk/protocol";

/*
 * A MOCK of the EveryOS desktop's end of the app bridge, for development and tests. It keeps
 * everything in memory and never talks to EveryOS: it is not a security boundary and proves
 * nothing about production. It applies the same capability rules as the real desktop (a
 * capability not in `granted` is refused) so permission handling can be exercised, and window-only
 * methods are unknown to widgets, as on the desktop.
 */

export const MOCK_LABEL = "EveryOS MOCK host";

/** The default EveryOS light and dark themes (Liquid), as the desktop hands them to apps. */
export const LIGHT_THEME: ThemeSnapshot = {
  scheme: "light",
  tokens: {
    "--everyos-accent": "2 132 199",
    "--everyos-accent-strong": "79 70 229",
    "--everyos-accent-contrast": "255 255 255",
    "--everyos-button-from": "2 121 183",
    "--everyos-button-to": "79 70 229",
    "--everyos-danger": "185 28 28",
    "--everyos-success": "4 120 87",
    "--everyos-warning": "146 64 14",
    "--everyos-text": "11 18 32",
    "--everyos-text-muted": "47 60 82",
    "--everyos-text-subtle": "79 93 115",
    "--everyos-surface": "248 250 252",
    "--everyos-surface-opacity": "0.660",
    "--everyos-surface-strong-opacity": "0.840",
    "--everyos-border": "15 23 42",
    "--everyos-border-opacity": "0.090",
    "--everyos-highlight-opacity": "0.55",
    "--everyos-shadow-opacity": "0.220",
    "--everyos-hover": "15 23 42",
    "--everyos-inset": "255 255 255",
    "--everyos-inset-opacity": "0.7",
    "--everyos-blur": "16px",
    "--everyos-saturate": "140%",
    "--everyos-radius-lg": "22px",
    "--everyos-radius-md": "14px",
    "--everyos-radius-sm": "10px",
    "--everyos-font-scale": "1.000",
  },
  accent: "#0284c7",
  fontFamily: "Inter, system-ui, sans-serif",
  reducedMotion: false,
  reducedTransparency: false,
  density: "comfortable",
};

export const DARK_THEME: ThemeSnapshot = {
  ...LIGHT_THEME,
  scheme: "dark",
  tokens: {
    "--everyos-accent": "125 211 252",
    "--everyos-accent-strong": "99 132 255",
    "--everyos-accent-contrast": "11 16 32",
    "--everyos-button-from": "125 211 252",
    "--everyos-button-to": "99 132 255",
    "--everyos-danger": "251 113 133",
    "--everyos-success": "52 211 153",
    "--everyos-warning": "251 191 36",
    "--everyos-text": "241 245 251",
    "--everyos-text-muted": "203 213 230",
    "--everyos-text-subtle": "163 177 201",
    "--everyos-surface": "16 22 38",
    "--everyos-surface-opacity": "0.810",
    "--everyos-surface-strong-opacity": "0.990",
    "--everyos-border": "255 255 255",
    "--everyos-border-opacity": "0.120",
    "--everyos-highlight-opacity": "0.1",
    "--everyos-shadow-opacity": "0.550",
    "--everyos-hover": "255 255 255",
    "--everyos-inset": "0 0 0",
    "--everyos-inset-opacity": "0.28",
    "--everyos-blur": "16px",
    "--everyos-saturate": "165%",
    "--everyos-radius-lg": "22px",
    "--everyos-radius-md": "14px",
    "--everyos-radius-sm": "10px",
    "--everyos-font-scale": "1.000",
  },
  accent: "#7dd3fc",
};

/** The port a mock host answers on (a DOM MessagePort or Node's). */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?: () => void;
  close(): void;
}

type HostResponder = (input: unknown) => unknown;

export interface MockHostOptions {
  app?: { id: string; version: string; name: string };
  kind?: "window" | "widget";
  widgetId?: string | null;
  /** Capabilities to simulate as granted (default: none). */
  granted?: string[];
  locale?: string;
  theme?: ThemeSnapshot;
  /** Virtual files the person "has" (`/notes/today.md` → text or bytes). */
  files?: Record<string, string | Uint8Array>;
  /** What the person picks in the file picker; default: every file matching the filter. */
  pick?: (request: Params<"files.open">) => string[] | null | Promise<string[] | null>;
  /** Where the person saves; default: `/<suggested name>`. */
  saveAs?: (request: Params<"files.save">) => string | null | Promise<string | null>;
  /** Answers of dialogs; default: confirm → true, prompt → the given value. */
  confirm?: (request: Params<"dialog.confirm">) => boolean | Promise<boolean>;
  prompt?: (request: Params<"dialog.prompt">) => string | null | Promise<string | null>;
  /** Answers of `host.call` operations; others report that the mock was not given one. */
  host?: Partial<Record<HostOperation, HostResponder>>;
  storage?: Record<string, unknown>;
  /** Persistent file handles from an earlier session (see `MockHost.persistentHandles()`). */
  handles?: PersistedHandle[];
  /** Restored window state. */
  state?: unknown;
}

/** A persistent handle as the mock keeps it between sessions. */
export interface PersistedHandle {
  id: string;
  path: string;
  kind: "file" | "directory";
  writable: boolean;
}

export interface MockCall {
  method: Method;
  params: unknown;
  ok: boolean;
  error?: string;
}

class Refusal extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Window-only methods: unknown to widgets, as on the desktop. */
const WINDOW_ONLY = /^(window\.(?!open$)|dialog\.|files\.|appearance\.)/;

const encoder = new TextEncoder();
const bytesOf = (value: string | Uint8Array) =>
  typeof value === "string" ? encoder.encode(value) : value;
const normalize = (path: string) => `/${path.split("/").filter(Boolean).join("/")}`;
const nameOf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";
const TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};
const typeOf = (name: string) => TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;

function matches(name: string, accept: readonly string[]): boolean {
  if (!accept.length) return true;
  const extension = name.includes(".") ? (name.split(".").at(-1)?.toLowerCase() ?? "") : "";
  const type = typeOf(name) ?? "";
  return accept.some((rule) =>
    rule.startsWith(".")
      ? rule.slice(1).toLowerCase() === extension
      : rule.endsWith("/*")
        ? type.startsWith(rule.slice(0, -1))
        : rule === type,
  );
}

/** A MOCK EveryOS desktop answering one app instance. See the module comment. */
export class MockHost {
  readonly mock = true;
  readonly label = MOCK_LABEL;
  /** Every request the app made, in order. */
  readonly calls: MockCall[] = [];
  readonly notifications: Array<Params<"notifications.send">> = [];
  readonly clipboard: string[] = [];
  readonly storage = new Map<string, unknown>();
  /** The virtual file system (`/path` → bytes). */
  readonly files = new Map<string, { data: Uint8Array; modifiedAt: number }>();
  /** Empty folders the app made (folders holding files exist through their files). */
  readonly folders = new Set<string>();
  readonly window: WindowState & { title: string; badge: number | null; state: unknown } = {
    visible: true,
    focused: true,
    maximized: false,
    width: 900,
    height: 640,
    title: "",
    badge: null,
    state: null,
  };
  readonly appearance: Omit<AppearanceState, "wallpaperPresets" | "folderIconPresets" | "limits"> =
    {
      wallpaper: null,
      desktops: [{ id: "d1", name: "Desktop", wallpaper: null, active: true }],
      wallpapers: [],
      folderIcon: null,
      folderIcons: [],
    };
  ready = false;
  closeGuarded = false;
  granted: Set<string>;
  readonly #options: MockHostOptions;
  readonly #handles = new Map<string, FileHandle & { path: string }>();
  readonly #writes = new Map<string, Uint8Array[]>();
  readonly #images = new Map<string, Uint8Array>();
  #theme: ThemeSnapshot;
  #locale: string;
  #port: PortLike | null = null;
  #next = 1;

  constructor(options: MockHostOptions = {}) {
    this.#options = options;
    this.granted = new Set(options.granted ?? []);
    this.#theme = options.theme ?? LIGHT_THEME;
    this.#locale = options.locale ?? "en";
    for (const [path, value] of Object.entries(options.files ?? {}))
      this.files.set(normalize(path), { data: bytesOf(value), modifiedAt: Date.now() });
    for (const [key, value] of Object.entries(options.storage ?? {})) this.storage.set(key, value);
    for (const handle of options.handles ?? []) {
      this.#handles.set(handle.id, {
        ...handle,
        name: nameOf(handle.path) || "/",
        size: handle.kind === "file" ? (this.files.get(handle.path)?.data.length ?? 0) : null,
        type: handle.kind === "file" ? typeOf(handle.path) : null,
        persistent: true,
      });
      this.#next = Math.max(this.#next, Number(handle.id.replace(/\D/g, "")) + 1);
    }
    this.window.state = options.state ?? null;
  }

  /** Persistent handles granted so far, to start a later session with (`handles` option). */
  persistentHandles(): PersistedHandle[] {
    return [...this.#handles.values()]
      .filter((handle) => handle.persistent)
      .map(({ id, path, kind, writable }) => ({ id, path, kind, writable }));
  }

  /** Simulates EveryOS withdrawing access to handles (the app hears `files.revoked`). */
  revoke(ids: string[]): void {
    for (const id of ids) this.#handles.delete(id);
    this.emit("files.revoked", { handles: ids });
  }

  get kind(): "window" | "widget" {
    return this.#options.kind ?? "window";
  }

  /** Answers the app on `port` and greets it (the app's `createApp()` resolves then). */
  connect(port: PortLike): void {
    this.#port = port;
    port.onmessage = (event) => void this.#handle(event.data as RequestMessage);
    port.start?.();
    const app = this.#options.app ?? { id: "dev.example.app", version: "0.0.0", name: "App" };
    const hello: HelloMessage = {
      kind: "hello",
      protocol: PROTOCOL,
      app,
      instance: {
        id: `mock-${this.kind}`,
        kind: this.kind,
        widgetId: this.kind === "widget" ? (this.#options.widgetId ?? null) : null,
      },
      granted: [...this.granted],
      locale: this.#locale,
      theme: this.#theme,
      window: this.#windowState(),
      everyos: { version: "mock", sdk: SDK_VERSION },
      state: this.window.state,
    };
    port.postMessage(hello);
  }

  disconnect(): void {
    this.#port?.close();
    this.#port = null;
  }

  emit<E extends EventName>(event: E, data: Events[E]): void {
    this.#port?.postMessage({ kind: "event", event, data });
  }

  /** Simulates granting or revoking capabilities (the app hears `permissions.changed`). */
  setGranted(capabilities: string[]): void {
    this.granted = new Set(capabilities);
    this.emit("permissions.changed", { granted: capabilities });
  }

  setTheme(theme: ThemeSnapshot): void {
    this.#theme = theme;
    this.emit("theme.changed", theme);
  }

  setLocale(locale: string): void {
    this.#locale = locale;
    this.emit("locale.changed", { locale });
  }

  /** The text of a virtual file (after the app saved it, for example). */
  readText(path: string): string | null {
    const file = this.files.get(normalize(path));
    return file ? new TextDecoder().decode(file.data) : null;
  }

  #windowState(): WindowState {
    const { visible, focused, maximized, width, height } = this.window;
    return { visible, focused, maximized, width, height };
  }

  #require(capability: string): void {
    if (!this.granted.has(capability))
      throw new Refusal(BRIDGE_ERRORS.permission, `The app may not use ${capability}`, {
        capability,
      });
  }

  #requireAny(capabilities: string[]): void {
    if (!capabilities.some((capability) => this.granted.has(capability)))
      this.#require(capabilities[0]!);
  }

  #handleOf(id: string): FileHandle & { path: string } {
    const handle = this.#handles.get(id);
    if (!handle) throw new Refusal(BRIDGE_ERRORS.invalid, "No such file handle");
    return handle;
  }

  #grant(path: string, kind: "file" | "directory", writable: boolean, persistent: boolean) {
    const id = `h${this.#next++}`;
    const file = this.files.get(path);
    const handle = {
      id,
      name: nameOf(path) || "/",
      kind,
      size: kind === "file" ? (file?.data.length ?? 0) : null,
      type: kind === "file" ? typeOf(path) : null,
      writable,
      persistent,
      path,
    };
    this.#handles.set(id, handle);
    const { path: _path, ...visible } = handle;
    return visible;
  }

  #isFolder(path: string): boolean {
    const prefix = `${path}/`;
    return (
      this.folders.has(path) ||
      [...this.files.keys(), ...this.folders].some((key) => key.startsWith(prefix))
    );
  }

  #inside(handle: { path: string; kind: string }, relative: string): string {
    if (relative.split("/").includes("..")) throw new Refusal(BRIDGE_ERRORS.invalid, "Bad path");
    if (handle.kind === "file") {
      if (relative) throw new Refusal(BRIDGE_ERRORS.invalid, "Not a folder");
      return handle.path;
    }
    return normalize(`${handle.path}/${relative}`);
  }

  async #handle(message: RequestMessage): Promise<void> {
    if (message?.kind !== "request") return;
    const { id, method, params } = message;
    try {
      if (this.kind === "widget" && WINDOW_ONLY.test(method))
        throw new Refusal(BRIDGE_ERRORS.unknownMethod, `Widgets cannot use ${method}`);
      const { result, transfer } = await this.#answer(method, params);
      this.calls.push({ method, params, ok: true });
      this.#port?.postMessage({ kind: "response", id, ok: true, result }, transfer ?? []);
    } catch (error) {
      const refusal =
        error instanceof Refusal
          ? error
          : new Refusal(BRIDGE_ERRORS.invalid, error instanceof Error ? error.message : "Failed");
      this.calls.push({ method, params, ok: false, error: refusal.code });
      this.#port?.postMessage({
        kind: "response",
        id,
        ok: false,
        error: { code: refusal.code, message: refusal.message, details: refusal.details },
      });
    }
  }

  async #answer(
    method: Method,
    params: unknown,
  ): Promise<{ result: unknown; transfer?: Transferable[] }> {
    const p = params as Record<string, unknown>;
    const done = (result: unknown = null) => ({ result });
    switch (method) {
      case "window.setTitle":
        this.window.title = String(p.title);
        return done();
      case "window.setBadge":
        this.window.badge = p.count as number | null;
        return done();
      case "window.focus":
      case "window.requestAttention":
      case "window.close":
      case "window.open":
        return done();
      case "window.minimize":
        this.window.visible = false;
        this.emit("lifecycle.suspend", null);
        return done();
      case "window.maximize":
        this.window.maximized = Boolean(p.maximized);
        return done();
      case "window.resize":
        this.window.width = Number(p.width);
        this.window.height = Number(p.height);
        return done(this.#windowState());
      case "window.getState":
        return done(this.#windowState());
      case "window.setState":
        if (JSON.stringify(p.state ?? null).length > 64 * 1024)
          throw new Refusal(BRIDGE_ERRORS.tooLarge, "Window state too large");
        this.window.state = p.state;
        return done();

      case "storage.get": {
        this.#require("storage:app");
        const key = String(p.key);
        return done(this.storage.has(key) ? { value: this.storage.get(key) } : null);
      }
      case "storage.set": {
        this.#require("storage:app");
        if (JSON.stringify(p.value).length > MAX_STORAGE_VALUE_BYTES)
          throw new Refusal(BRIDGE_ERRORS.tooLarge, "Value too large");
        this.storage.set(String(p.key), structuredClone(p.value));
        return done();
      }
      case "storage.delete":
        this.#require("storage:app");
        this.storage.delete(String(p.key));
        return done();
      case "storage.keys":
        this.#require("storage:app");
        return done(
          [...this.storage.keys()]
            .filter((key) => key.startsWith(String(p.prefix)))
            .sort()
            .map((key) => ({ key, size: JSON.stringify(this.storage.get(key)).length })),
        );
      case "storage.usage": {
        this.#require("storage:app");
        let used = 0;
        for (const [key, value] of this.storage) used += key.length + JSON.stringify(value).length;
        return done({ used, quota: 16 * 1024 * 1024, keys: this.storage.size });
      }
      case "storage.clear":
        this.#require("storage:app");
        this.storage.clear();
        return done();

      case "files.open": {
        const request = params as Params<"files.open">;
        this.#require(request.write ? "files:save" : "files:pick");
        const picked =
          (await this.#options.pick?.(request)) ??
          (request.directory
            ? ["/"]
            : [...this.files.keys()]
                .filter((path) => matches(path, request.accept))
                .sort()
                .slice(0, request.multiple ? undefined : 1));
        return done(
          picked.map((path) =>
            this.#grant(
              normalize(path),
              request.directory ? "directory" : "file",
              request.write,
              request.persist,
            ),
          ),
        );
      }
      case "files.save": {
        const request = params as Params<"files.save">;
        this.#require("files:save");
        const path = this.#options.saveAs
          ? await this.#options.saveAs(request)
          : `/${request.suggestedName}`;
        if (path === null) return done(null);
        if (!this.files.has(normalize(path)))
          this.files.set(normalize(path), { data: new Uint8Array(), modifiedAt: Date.now() });
        return done(this.#grant(normalize(path), "file", true, request.persist));
      }
      case "files.read": {
        this.#requireAny(["files:pick", "files:save"]);
        const handle = this.#handleOf(String(p.handle));
        const file = this.files.get(handle.path);
        if (!file || handle.kind !== "file") throw new Refusal(BRIDGE_ERRORS.invalid, "No file");
        const offset = Number(p.offset);
        const length = Math.min(Number(p.length), MAX_CHUNK_BYTES);
        const chunk = file.data.slice(offset, offset + length);
        return {
          result: { data: chunk.buffer, eof: offset + chunk.length >= file.data.length },
          transfer: [chunk.buffer],
        };
      }
      case "files.write": {
        this.#require("files:save");
        const handle = this.#handleOf(String(p.handle));
        if (!handle.writable) throw new Refusal(BRIDGE_ERRORS.permission, "Read-only handle");
        const offset = Number(p.offset);
        const chunks = offset === 0 ? [] : (this.#writes.get(handle.id) ?? null);
        const written = chunks?.reduce((sum, chunk) => sum + chunk.length, 0) ?? -1;
        if (!chunks || written !== offset)
          throw new Refusal(BRIDGE_ERRORS.invalid, "Chunks must arrive in order");
        chunks.push(new Uint8Array(p.data as ArrayBuffer));
        this.#writes.set(handle.id, chunks);
        const size = written + (p.data as ArrayBuffer).byteLength;
        if (p.done) {
          const data = new Uint8Array(size);
          let at = 0;
          for (const chunk of chunks) {
            data.set(chunk, at);
            at += chunk.length;
          }
          this.files.set(handle.path, { data, modifiedAt: Date.now() });
          this.#writes.delete(handle.id);
        }
        return done({ size });
      }
      case "files.list": {
        this.#requireAny(["files:pick", "files:save"]);
        const folder = this.#inside(
          this.#handleOf(String(p.handle)),
          typeof p.path === "string" ? p.path : "",
        );
        const entries = new Map<string, DirectoryEntry>();
        for (const [path, file] of this.files) {
          if (!path.startsWith(folder === "/" ? "/" : `${folder}/`)) continue;
          const rest = path.slice(folder === "/" ? 1 : folder.length + 1).split("/");
          const name = rest[0]!;
          if (rest.length === 1)
            entries.set(name, {
              name,
              kind: "file",
              size: file.data.length,
              modifiedAt: file.modifiedAt,
            });
          else if (!entries.has(name))
            entries.set(name, { name, kind: "directory", size: null, modifiedAt: file.modifiedAt });
        }
        for (const path of this.folders) {
          if (!path.startsWith(folder === "/" ? "/" : `${folder}/`)) continue;
          const name = path.slice(folder === "/" ? 1 : folder.length + 1).split("/")[0]!;
          if (!entries.has(name))
            entries.set(name, { name, kind: "directory", size: null, modifiedAt: 0 });
        }
        return done([...entries.values()].sort((a, b) => a.name.localeCompare(b.name)));
      }
      case "files.child": {
        this.#requireAny(["files:pick", "files:save"]);
        const parent = this.#handleOf(String(p.handle));
        const path = this.#inside(parent, String(p.path));
        if (p.create) {
          this.#require("files:save");
          if (!parent.writable) throw new Refusal(BRIDGE_ERRORS.permission, "Read-only folder");
        }
        // Like the desktop, creating something that exists hands out the existing entry.
        if (p.create === "file" && !this.files.has(path) && !this.#isFolder(path))
          this.files.set(path, { data: new Uint8Array(), modifiedAt: Date.now() });
        if (p.create === "directory" && !this.files.has(path)) this.folders.add(path);
        const isFile = this.files.has(path);
        const isFolder = this.#isFolder(path);
        if (!isFile && !isFolder && p.create !== "directory")
          throw new Refusal(BRIDGE_ERRORS.invalid, "No such file");
        return done(
          this.#grant(path, isFile ? "file" : "directory", parent.writable, parent.persistent),
        );
      }
      case "files.url": {
        this.#requireAny(["files:pick", "files:save"]);
        const handle = this.#handleOf(String(p.handle));
        const file = this.files.get(handle.path);
        if (!file) throw new Refusal(BRIDGE_ERRORS.invalid, "No file");
        const type = typeOf(handle.path) ?? "application/octet-stream";
        const url =
          typeof URL.createObjectURL === "function" && typeof Blob === "function"
            ? URL.createObjectURL(new Blob([file.data.slice()], { type }))
            : `data:${type};base64,${btoa(String.fromCharCode(...file.data))}`;
        return done({ url, expiresAt: Date.now() + 10 * 60_000 });
      }
      case "files.handles":
        return done([...this.#handles.values()].map(({ path: _path, ...handle }) => handle));
      case "files.revoke":
        this.#handles.delete(String(p.handle));
        return done();

      case "notifications.send":
        this.#require("notifications:send");
        this.notifications.push(params as Params<"notifications.send">);
        return done();
      case "dialog.alert":
        return done();
      case "dialog.confirm":
        return done((await this.#options.confirm?.(params as Params<"dialog.confirm">)) ?? true);
      case "dialog.prompt":
        return done(
          this.#options.prompt
            ? await this.#options.prompt(params as Params<"dialog.prompt">)
            : p.value,
        );
      case "clipboard.writeText":
        this.#require("clipboard:write");
        this.clipboard.push(String(p.text));
        return done();
      case "theme.get":
        return done(this.#theme);
      case "locale.get":
        return done({ locale: this.#locale });
      case "lifecycle.ready":
        this.ready = true;
        return done();
      case "lifecycle.guardClose":
        this.closeGuarded = Boolean(p.enabled);
        return done();
      case "lifecycle.closeDecision":
        return done();

      case "appearance.get":
        this.#require("appearance:manage");
        return done({
          ...structuredClone(this.appearance),
          wallpaperPresets: [{ id: "aurora", name: "Aurora", scheme: "dark" }],
          folderIconPresets: [{ id: "classic", name: "Classic" }],
          limits: {
            wallpapers: 20,
            wallpaperBytes: 10 * 1024 * 1024,
            folderIconBytes: 2 * 1024 * 1024,
            folderIconEdge: 1024,
          },
        } satisfies AppearanceState);
      case "appearance.image": {
        this.#require("appearance:manage");
        const source = p.source as { kind: string; id: string };
        const bytes = this.#images.get(`${source.kind}:${source.id}`) ?? new Uint8Array([0]);
        const copy = bytes.slice();
        return { result: { data: copy.buffer, type: "image/png" }, transfer: [copy.buffer] };
      }
      case "appearance.upload": {
        this.#require("appearance:manage");
        const image: AppearanceImage = {
          id: `img${this.#next++}`,
          type: p.type as AppearanceImage["type"],
          size: (p.data as ArrayBuffer).byteLength,
          width: 1,
          height: 1,
          createdAt: Date.now(),
        };
        this.#images.set(`${String(p.kind)}:${image.id}`, new Uint8Array(p.data as ArrayBuffer));
        (p.kind === "wallpaper" ? this.appearance.wallpapers : this.appearance.folderIcons).push(
          image,
        );
        this.emit("appearance.changed", null);
        return done(image);
      }
      case "appearance.deleteImage": {
        this.#require("appearance:manage");
        const list =
          p.kind === "wallpaper" ? this.appearance.wallpapers : this.appearance.folderIcons;
        const at = list.findIndex((image) => image.id === p.id);
        if (at >= 0) list.splice(at, 1);
        this.emit("appearance.changed", null);
        return done();
      }
      case "appearance.setWallpaper": {
        this.#require("appearance:manage");
        const wallpaper = p.wallpaper as WallpaperChoice | null;
        if (p.desktopId === null) this.appearance.wallpaper = wallpaper;
        else {
          const desktop = this.appearance.desktops.find((entry) => entry.id === p.desktopId);
          if (!desktop) throw new Refusal(BRIDGE_ERRORS.invalid, "No such desktop");
          desktop.wallpaper = wallpaper;
        }
        this.emit("appearance.changed", null);
        return done();
      }
      case "appearance.setFolderIcon":
        this.#require("appearance:manage");
        this.appearance.folderIcon = p.icon as FolderIconChoice | null;
        this.emit("appearance.changed", null);
        return done();

      case "host.call": {
        const operation = p.operation as HostOperation;
        const capability = HOST_OPERATION_CAPABILITY[operation];
        if (!capability) throw new Refusal(BRIDGE_ERRORS.invalid, "Unknown operation");
        if (capability === "integration:*")
          this.#require(
            [...this.granted].find((granted) => granted.startsWith("integration:")) ?? capability,
          );
        else this.#require(capability);
        const responder = this.#options.host?.[operation];
        if (!responder)
          throw new Refusal(
            "EVERYOS_MOCK_UNANSWERED",
            `${MOCK_LABEL}: no answer was given for ${operation} (pass it in \`host\`)`,
            { operation },
          );
        return done(await responder(p.input));
      }
    }
    throw new Refusal(BRIDGE_ERRORS.unknownMethod, `Unknown method ${String(method)}`);
  }
}
