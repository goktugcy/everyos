import { BridgeError, connect, type Connection } from "./client.ts";
import {
  MAX_CHUNK_BYTES,
  type AppearanceImage,
  type AppearanceImageKind,
  type AppearanceImageSource,
  type AppearanceState,
  type DirectoryEntry,
  type FolderIconChoice,
  type WallpaperChoice,
  type Events,
  type FileHandle,
  type HostInput,
  type HostOperation,
  type HostResult,
  type NotificationLevel,
  type ThemeSnapshot,
  type WindowState,
} from "./protocol.ts";

export { BridgeError } from "./client.ts";
export type {
  AppearanceImage,
  AppearanceImageKind,
  AppearanceImageSource,
  AppearanceState,
  FolderIconChoice,
  WallpaperChoice,
  DbColumn,
  DbConnection,
  DbEngine,
  DbParam,
  DbQueryInput,
  DbQueryResult,
  DbTable,
  DirectoryEntry,
  DiskUsage,
  DnsRecord,
  DnsRecordType,
  FileHandle,
  HostInput,
  HostOperation,
  HostOperations,
  HostResult,
  HttpHeader,
  HttpMethod,
  IntegrationData,
  IntegrationInfo,
  LogEntry,
  LogPage,
  LogQuery,
  NetDnsQuery,
  NetDnsResult,
  NetFailure,
  NetHttpRequest,
  NetHttpResponse,
  NetMonitor,
  NetMonitorCheck,
  NetMonitorInput,
  NetMonitorState,
  NetTlsResult,
  NetTlsTarget,
  NotificationLevel,
  SshKey,
  SshKeyType,
  SystemCapabilityStatus,
  SystemDataSource,
  SystemInfo,
  SystemMetrics,
  SystemMetricsPoint,
  SystemNetwork,
  SystemServices,
  SystemSockets,
  SystemStorage,
  ThemeSnapshot,
  TlsCertificate,
  WindowState,
} from "./protocol.ts";
export {
  DB_LIMITS,
  DNS_RECORD_TYPES,
  HTTP_METHODS,
  NET_LIMITS,
  SSH_KEY_TYPES,
} from "./protocol.ts";
export { createI18n, packageMessages, type I18n, type Messages } from "./i18n.ts";

type Unsubscribe = () => void;

export interface EveryOSApp {
  readonly app: { id: string; version: string; name: string };
  readonly instance: { id: string; kind: "window" | "widget"; widgetId: string | null };
  readonly everyos: { version: string; sdk: string };

  window: {
    /** State saved for this window before a reload (`saveState`), or null for a new window. */
    readonly initialState: unknown;
    setTitle(title: string): Promise<void>;
    setBadge(count: number | null): Promise<void>;
    focus(): Promise<void>;
    requestAttention(): Promise<void>;
    minimize(): Promise<void>;
    maximize(maximized?: boolean): Promise<void>;
    resize(width: number, height: number): Promise<WindowState>;
    close(): Promise<void>;
    state(): Promise<WindowState>;
    saveState(state: unknown): Promise<void>;
    /** A window of this app (another one, when the app allows several), with initial state. */
    open(state?: unknown): Promise<void>;
    /**
     * The window, already running, was opened again with new state (`open(state)` from a widget,
     * for example): show what the state asks for.
     */
    onOpened(listener: (state: unknown) => void): Unsubscribe;
    onChange(listener: (state: WindowState) => void): Unsubscribe;
  };

  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix?: string): Promise<Array<{ key: string; size: number }>>;
    usage(): Promise<{ used: number; quota: number; keys: number }>;
    clear(): Promise<void>;
    /**
     * Runs the steps between the stored schema version and `version` once, in order, recording
     * progress after each step (a failed step runs again next time).
     */
    migrate(version: number, steps: Record<number, () => Promise<void>>): Promise<number>;
  };

  files: {
    open(options?: {
      accept?: string[];
      multiple?: boolean;
      directory?: boolean;
      persist?: boolean;
      write?: boolean;
    }): Promise<FileHandle[]>;
    save(options: {
      suggestedName: string;
      accept?: string[];
      persist?: boolean;
    }): Promise<FileHandle | null>;
    read(
      handle: FileHandle | string,
      options?: { signal?: AbortSignal; maxBytes?: number },
    ): Promise<ArrayBuffer>;
    readText(handle: FileHandle | string): Promise<string>;
    write(handle: FileHandle | string, data: ArrayBuffer | Uint8Array | string): Promise<number>;
    list(handle: FileHandle | string, path?: string): Promise<DirectoryEntry[]>;
    child(
      handle: FileHandle | string,
      path: string,
      create?: "file" | "directory",
    ): Promise<FileHandle>;
    url(handle: FileHandle | string): Promise<string>;
    handles(): Promise<FileHandle[]>;
    revoke(handle: FileHandle | string): Promise<void>;
    onRevoked(listener: (handles: string[]) => void): Unsubscribe;
  };

  notifications: {
    send(notification: {
      title: string;
      body?: string;
      level?: NotificationLevel;
      tag?: string;
    }): Promise<void>;
  };

  dialogs: {
    alert(title: string, message?: string): Promise<void>;
    confirm(
      title: string,
      message?: string,
      options?: { confirm?: string; destructive?: boolean },
    ): Promise<boolean>;
    prompt(
      title: string,
      message?: string,
      options?: { value?: string; placeholder?: string },
    ): Promise<string | null>;
  };

  clipboard: { writeText(text: string): Promise<void> };

  /** The person's wallpapers and folder icons (appearance:manage). */
  appearance: {
    get(): Promise<AppearanceState>;
    /** An uploaded image or a preset's preview, as a Blob scaled to fit `maxEdge` pixels. */
    image(source: AppearanceImageSource, maxEdge?: number): Promise<Blob>;
    upload(kind: AppearanceImageKind, image: Blob): Promise<AppearanceImage>;
    deleteImage(kind: AppearanceImageKind, id: string): Promise<void>;
    /** One desktop's wallpaper, or (`desktopId` null) the default of every desktop. */
    setWallpaper(wallpaper: WallpaperChoice | null, desktopId?: string | null): Promise<void>;
    setFolderIcon(icon: FolderIconChoice | null): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
  };

  theme: {
    readonly current: ThemeSnapshot;
    /** Applies the desktop's tokens to the document (CSS variables, color scheme, motion). */
    apply(root?: HTMLElement): void;
    onChange(listener: (theme: ThemeSnapshot) => void): Unsubscribe;
  };

  locale: {
    readonly current: string;
    onChange(listener: (locale: string) => void): Unsubscribe;
  };

  lifecycle: {
    /** Tells the desktop the app is ready (its loading indicator goes away). */
    ready(): Promise<void>;
    onSuspend(listener: () => void): Unsubscribe;
    onResume(listener: () => void): Unsubscribe;
    /**
     * Asks `shouldClose` before the window closes (e.g. unsaved changes). Return false to keep it
     * open. Passing null removes the guard.
     */
    guardClose(shouldClose: (() => boolean | Promise<boolean>) | null): Promise<void>;
    onUpdated(listener: (version: string) => void): Unsubscribe;
  };

  permissions: {
    readonly granted: ReadonlySet<string>;
    has(capability: string): boolean;
    onChange(listener: (granted: ReadonlySet<string>) => void): Unsubscribe;
  };

  host: {
    /** Server-backed data behind a capability (docs/app-sdk/permissions.md). */
    call<O extends HostOperation>(operation: O, input?: HostInput<O>): Promise<HostResult<O>>;
  };
}

const id = (handle: FileHandle | string) => (typeof handle === "string" ? handle : handle.id);

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function applyTheme(theme: ThemeSnapshot, root: HTMLElement): void {
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
  root.style.setProperty("--everyos-font-family", theme.fontFamily);
  root.dataset.everyosScheme = theme.scheme;
  root.dataset.everyosDensity = theme.density;
  root.toggleAttribute("data-everyos-reduced-motion", theme.reducedMotion);
  root.toggleAttribute("data-everyos-reduced-transparency", theme.reducedTransparency);
}

function build(connection: Connection): EveryOSApp {
  const { hello } = connection;
  let theme = hello.theme;
  let locale = hello.locale;
  let granted: ReadonlySet<string> = new Set(hello.granted);
  const request = connection.request.bind(connection);
  const on = <E extends keyof Events>(event: E, listener: (data: Events[E]) => void) =>
    connection.on(event, listener);
  let closeGuard: (() => boolean | Promise<boolean>) | null = null;

  on("theme.changed", (next) => (theme = next));
  on("locale.changed", (next) => (locale = next.locale));
  on("permissions.changed", (next) => (granted = new Set(next.granted)));
  on("lifecycle.beforeClose", ({ requestId }) => {
    void (async () => {
      let close: boolean;
      try {
        close = closeGuard ? await closeGuard() : true;
      } catch {
        close = false;
      }
      await request("lifecycle.closeDecision", { requestId, close });
    })();
  });

  const storage: EveryOSApp["storage"] = {
    async get<T>(key: string) {
      const found = await request("storage.get", { key });
      return found ? (found.value as T) : undefined;
    },
    set: async (key, value) => void (await request("storage.set", { key, value })),
    delete: async (key) => void (await request("storage.delete", { key })),
    keys: (prefix = "") => request("storage.keys", { prefix }),
    usage: () => request("storage.usage", null),
    clear: async () => void (await request("storage.clear", null)),
    async migrate(version, steps) {
      let current = (await storage.get<number>("__schema")) ?? 0;
      while (current < version) {
        const step = steps[current + 1];
        if (step) await step();
        current += 1;
        await storage.set("__schema", current);
      }
      return current;
    },
  };

  const files: EveryOSApp["files"] = {
    open: (options = {}) =>
      request("files.open", {
        accept: options.accept ?? [],
        multiple: options.multiple ?? false,
        directory: options.directory ?? false,
        persist: options.persist ?? false,
        write: options.write ?? false,
      }),
    save: (options) =>
      request("files.save", {
        suggestedName: options.suggestedName,
        accept: options.accept ?? [],
        persist: options.persist ?? false,
      }),
    async read(handle, options = {}) {
      if (
        options.maxBytes !== undefined &&
        (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      )
        throw new RangeError("Invalid file read limit");
      const chunks: Uint8Array[] = [];
      let offset = 0;
      for (;;) {
        options.signal?.throwIfAborted();
        const { data, eof } = await request("files.read", {
          handle: id(handle),
          offset,
          length: MAX_CHUNK_BYTES,
        });
        if (options.maxBytes !== undefined && offset + data.byteLength > options.maxBytes)
          throw new RangeError(`too-large:${options.maxBytes}`);
        chunks.push(new Uint8Array(data));
        offset += data.byteLength;
        if (eof) break;
      }
      const out = new Uint8Array(offset);
      let position = 0;
      for (const chunk of chunks) {
        out.set(chunk, position);
        position += chunk.length;
      }
      return out.buffer;
    },
    readText: async (handle) => new TextDecoder().decode(await files.read(handle)),
    async write(handle, data) {
      const bytes = toBytes(data);
      let size: number;
      let offset = 0;
      do {
        const chunk = bytes.slice(offset, offset + MAX_CHUNK_BYTES);
        // Transferring the chunk detaches its buffer: take its length first.
        const length = chunk.length;
        ({ size } = await request(
          "files.write",
          {
            handle: id(handle),
            offset,
            data: chunk.buffer,
            done: offset + length >= bytes.length,
          },
          { transfer: [chunk.buffer], timeoutMs: 120_000 },
        ));
        offset += length;
      } while (offset < bytes.length);
      return size;
    },
    list: (handle, path = "") => request("files.list", { handle: id(handle), path }),
    child: (handle, path, create) =>
      request("files.child", { handle: id(handle), path, create: create ?? null }),
    url: async (handle) => (await request("files.url", { handle: id(handle) })).url,
    handles: () => request("files.handles", null),
    revoke: async (handle) => void (await request("files.revoke", { handle: id(handle) })),
    onRevoked: (listener) => on("files.revoked", ({ handles }) => listener(handles)),
  };

  return {
    app: hello.app,
    instance: hello.instance,
    everyos: hello.everyos,
    window: {
      initialState: hello.state,
      setTitle: async (title) => void (await request("window.setTitle", { title })),
      setBadge: async (count) => void (await request("window.setBadge", { count })),
      focus: async () => void (await request("window.focus", null)),
      requestAttention: async () => void (await request("window.requestAttention", null)),
      minimize: async () => void (await request("window.minimize", null)),
      maximize: async (maximized = true) => void (await request("window.maximize", { maximized })),
      resize: (width, height) => request("window.resize", { width, height }),
      close: async () => void (await request("window.close", null)),
      state: () => request("window.getState", null),
      saveState: async (state) => void (await request("window.setState", { state })),
      open: async (state = null) => void (await request("window.open", { state })),
      onOpened: (listener) => on("window.opened", ({ state }) => listener(state)),
      onChange: (listener) => on("window.changed", listener),
    },
    storage,
    files,
    notifications: {
      send: async (notification) =>
        void (await request("notifications.send", {
          title: notification.title,
          body: notification.body ?? "",
          level: notification.level ?? "info",
          tag: notification.tag ?? null,
        })),
    },
    dialogs: {
      alert: async (title, message = "") =>
        void (await request("dialog.alert", { title, message })),
      confirm: (title, message = "", options = {}) =>
        request("dialog.confirm", {
          title,
          message,
          confirm: options.confirm ?? null,
          destructive: options.destructive ?? false,
        }),
      prompt: (title, message = "", options = {}) =>
        request("dialog.prompt", {
          title,
          message,
          value: options.value ?? "",
          placeholder: options.placeholder ?? null,
        }),
    },
    clipboard: {
      writeText: async (text) => void (await request("clipboard.writeText", { text })),
    },
    appearance: {
      get: () => request("appearance.get", null),
      image: async (source, maxEdge = 512) => {
        const { data, type } = await request("appearance.image", { source, maxEdge });
        return new Blob([data], { type });
      },
      upload: async (kind, image) => {
        const type = image.type as AppearanceImage["type"];
        const data = await image.arrayBuffer();
        return request(
          "appearance.upload",
          { kind, data, type },
          { transfer: [data], timeoutMs: 120_000 },
        );
      },
      deleteImage: async (kind, id) => void (await request("appearance.deleteImage", { kind, id })),
      setWallpaper: async (wallpaper, desktopId = null) =>
        void (await request("appearance.setWallpaper", { desktopId, wallpaper })),
      setFolderIcon: async (icon) => void (await request("appearance.setFolderIcon", { icon })),
      onChange: (listener) => on("appearance.changed", () => listener()),
    },
    theme: {
      get current() {
        return theme;
      },
      apply(root = document.documentElement) {
        applyTheme(theme, root);
        on("theme.changed", (next) => applyTheme(next, root));
      },
      onChange: (listener) => on("theme.changed", listener),
    },
    locale: {
      get current() {
        return locale;
      },
      onChange: (listener) => on("locale.changed", (next) => listener(next.locale)),
    },
    lifecycle: {
      ready: async () => void (await request("lifecycle.ready", null)),
      onSuspend: (listener) => on("lifecycle.suspend", () => listener()),
      onResume: (listener) => on("lifecycle.resume", () => listener()),
      async guardClose(shouldClose) {
        closeGuard = shouldClose;
        await request("lifecycle.guardClose", { enabled: shouldClose !== null });
      },
      onUpdated: (listener) => on("app.updated", ({ version }) => listener(version)),
    },
    permissions: {
      get granted() {
        return granted;
      },
      has: (capability) => granted.has(capability),
      onChange: (listener) => on("permissions.changed", () => listener(granted)),
    },
    host: {
      // The server answers with the operation's result type (sdk-host-routes is typed by it).
      call: <O extends HostOperation>(operation: O, input: HostInput<O> | null = null) =>
        request("host.call", { operation, input }) as Promise<HostResult<O>>,
    },
  };
}

let current: Promise<EveryOSApp> | null = null;

/**
 * Connects to EveryOS (once per page) and returns the app's API. Rejects with a BridgeError when
 * the page is not running in an EveryOS window.
 */
export function createApp(options: { timeoutMs?: number } = {}): Promise<EveryOSApp> {
  current ??= connect(options).then(build);
  current.catch(() => (current = null));
  return current;
}

/**
 * Forgets the connection, so the next `createApp()` connects again. Only for tests that start the
 * mock desktop several times in one page (`@everyos/app-testing` does it on `unmount()`): on
 * EveryOS, every window and widget is a page of its own.
 */
export function resetApp(): void {
  current = null;
}

export function isBridgeError(error: unknown, code?: string): error is BridgeError {
  return error instanceof BridgeError && (code === undefined || error.code === code);
}
