# EveryOS App SDK reference

This reference covers the public `@everyos/app-sdk` 1.0.0 API. The
[TypeScript contract](../../packages/app-sdk/src/index.ts),
[bridge value types](../../packages/app-sdk/src/protocol.ts) and
[host operation types](../../packages/app-sdk/src/host-operations.ts) are shipped with the package.
They contain no zod dependency. App UI components and React hooks are a separate optional package,
`@everyos/app-ui`, bundled into an app rather than loaded from a privileged shared runtime.

## Connection and identity

`await createApp({ timeoutMs?: number })` connects once per page to EveryOS's transferred
MessageChannel. The optional timeout bounds the initial handshake (15 seconds by default).
It returns `EveryOSApp`; outside EveryOS, it fails instead of inventing a host. Develop with
the explicitly labelled [mock desktop](testing.md) or install a development package on EveryOS.

`app.app` is the installed identity and version. `app.instance` identifies this window/widget;
`widgetId` is null in windows. `app.everyos` gives the host and SDK versions. They are host-provided
metadata, not credentials. Do not construct bridge messages, fetch `/api` or infer another app's
identity from a file path. Calls run with the installation, user and instance that EveryOS issued.

The public instance contract is reproduced below. `Unsubscribe` is `() => void`; value types such
as `FileHandle`, `WindowState`, `ThemeSnapshot` and `HostResult` are exported by the package.

```ts
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
    read(handle: FileHandle | string, options?: { signal?: AbortSignal }): Promise<ArrayBuffer>;
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
```

## Windows

`initialState` is the state supplied on opening or restored with `saveState`. `saveState` is for
per-window navigation; use `storage` for durable application data. `open(state)` opens the app
from a widget or requests another window. For single-instance apps, the already-open window
receives `onOpened(state)`; read the state and navigate to the requested item.

`onChange` reports visibility, focus, maximization and dimensions. Pause expensive work when not
visible and resume by reading current state. Window geometry is controlled by EveryOS and must
respect mobile/fullscreen layouts. `setBadge(null)` clears the badge. `maximize()` maximizes by
default; passing false restores. The ordinary window-management methods are unavailable in widget
frames; opening the parent app is supported there. See [widgets](widgets.md).

## Storage

Requires `storage:app`. Values are JSON-encoded and isolated by app and person. A value is at most
256 KiB; split large indexes/documents across keys. `keys(prefix)` returns key names and byte sizes,
not values. `usage()` reports actual usage and quota. `get<T>()` is a TypeScript convenience, not
runtime validation: validate data and migrate older shapes before using them.

`migrate(version, steps)` uses the `__schema` key, records completed integer steps and resumes a failed migration on the
next attempt. Each step is an async function keyed by its target version. Do not assume a
multi-key transaction or silently discard data you cannot decode. Retain recoverable data and show
a useful error when storage fails or quota is exhausted.

For React apps, `usePersistentState` in the kit reads, saves after an editing pause and flushes
on suspend/pagehide. Do not expose editing controls before its `loaded` state; an edit against
defaults can overwrite saved settings. Keep each value within the storage limit.

## Files and the picker

Requires `files:pick` for selecting/reading and `files:save` for writing. A role must also allow
the underlying file action. There are no ambient filesystem paths. `open()` returns only handles
the person selected; cancellation yields `[]`. `save()` returns a writable destination or null.

- `accept` lists extensions/MIME filters; the picker remains the authority for the selection.
- `multiple` permits selecting several files. `directory` requests a directory handle.
- `write` asks for write access when selecting a handle.
- `persist` asks to retain access across window closure; the person can revoke it later.
- `FileHandle` contains an opaque `id`, name, kind, optional size/type, `writable` and `persistent`.
  Store IDs only for persistent handles. Reconcile saved references with `handles()` and listen
  for `onRevoked` while the app is open.
- `read` returns the whole file as an `ArrayBuffer`, with optional cancellation. `readText`
  decodes text. Account for memory before reading large files.
- `write` accepts text or bytes and returns the byte count. Transport is chunked by the SDK;
  callers must await errors and confirm destructive replacement in their own workflow.
- `list` and `child` operate beneath a granted directory. Relative paths cannot escape it.
  `child(..., "file" | "directory")` explicitly creates a child when requested.
- `url` issues a short-lived scoped media URL, with byte-range support. Use it in an image,
  audio or video element; do not persist the URL or share it. Request a fresh URL when needed.
  Access is checked against the file grant; `files.revoke` relinquishes that grant. Blob URLs
  your app creates independently must instead be released with `URL.revokeObjectURL`.

Widgets cannot open pickers or perform window-only file workflows. See the tested
[Text Editor](../../official-apps/text/README.md), [Code Editor](../../official-apps/code/README.md)
and [PDF Viewer](../../official-apps/pdf/README.md) for actual open/save/persistent-handle examples.

## Notifications, dialogs and clipboard

`notifications.send` requires `notifications:send`. Title/body are plain text (at most 120/200
characters respectively); an optional tag is at most 64 characters. `level` is `info`,
`success`, `warning` or `critical`; `tag` is optional. EveryOS applies ownership, muting and rate
limits. A notification request is not evidence of delivery to an external service.

`dialogs.alert`, `confirm` and `prompt` use EveryOS's host UI and return a promise.
`confirm` returns a boolean, `prompt` returns a string or null on cancellation. Mark destructive
confirmations with `{ destructive: true }`; `confirm` can customize its affirmative label.
Dialogs and pickers wait for the person rather than using the ordinary request timeout. They are
window-only. Treat cancellation as normal workflow, not a failure.

Dialog titles are at most 200 characters, messages 2,000, a custom affirmative label 40,
prompt values 1,000 and prompt placeholders 200.

`clipboard.writeText` requires `clipboard:write` and copies only the supplied text through the
desktop. Use it for an explicit user action and handle browser restrictions/failure. The SDK
does not provide arbitrary clipboard reads.

## Theme, locale and lifecycle

Call `theme.apply()` once during startup to apply the host's CSS variables and follow changes.
`theme.current` contains `scheme`, `tokens`, accent, font family, density and reduced-motion /
reduced-transparency preferences. `theme.onChange` supports custom rendering such as a canvas;
unsubscribe when it is no longer displayed. Avoid loading external fonts or hardcoding colors.

`locale.current` is the host's selected language; `locale.onChange` reports changes.
See internationalization below for loading the app's own messages. The React kit connects these
events automatically; a vanilla app must update its own rendering.

Call `lifecycle.ready()` after initialization so the desktop can remove its loading state.
`onSuspend` and `onResume` are visibility/lifecycle signals, not background execution guarantees.
Flush edits when suspending; start the final write synchronously in the `pagehide` handler.
Do not start a chain of unrelated asynchronous reads there and expect them to finish after close.
EveryOS briefly retires a closing bridge to allow in-flight saves; that is not a durable job queue.

`guardClose` registers an async/sync close decision; false keeps the window open. Pass null to
remove it. A close guard complements saving while editing. `onUpdated` reports the new installed
version so the app can make an orderly transition. Remove event listeners, timers, workers and
object URLs during cleanup. Widget lifetime can be much shorter than a desktop session.

## Permissions and host operations

`permissions.has` and `granted` support interface decisions. `onChange` reports withdrawal or
approval immediately. They are not an authorization boundary: the desktop and API validate every
operation, ownership, role, capability, quotas and operation-specific policy.

`host.call(operation, input?)` is a typed operation union. There is no generic shell, arbitrary
agent command or unrestricted HTTP proxy. An absent input is appropriate only for an operation
whose input is null. The complete input/result map is:

```ts
export interface HostOperations {
  "system.metrics": { input: null; result: SystemMetrics };
  "system.info": { input: null; result: SystemInfo };
  "system.sockets": { input: null; result: SystemSockets };
  "system.network": { input: null; result: SystemNetwork };
  "system.storage": { input: null; result: SystemStorage };
  "system.services": { input: null; result: SystemServices };
  "logs.query": { input: LogQuery; result: LogPage };
  /** `handle`: a folder the person shared with the app (`files.open({ directory: true })`). */
  "disk.usage": { input: { handle: string; path?: string }; result: DiskUsage };
  "integration.list": { input: null; result: { integrations: IntegrationInfo[] } };
  "integration.data": { input: { integration: string; feed: string }; result: IntegrationData };
  "net.http": { input: NetHttpRequest; result: NetHttpResponse };
  "net.dns": { input: NetDnsQuery; result: NetDnsResult };
  "net.tls": { input: NetTlsTarget; result: NetTlsResult };
  "net.monitors.list": { input: null; result: { monitors: NetMonitor[] } };
  "net.monitors.history": {
    input: { id: string; since?: number; limit?: number };
    result: { checks: NetMonitorCheck[] };
  };
  "net.monitors.save": { input: NetMonitorInput; result: NetMonitor };
  "net.monitors.delete": { input: { id: string }; result: null };
  /** Checks now (at most once every 10 seconds per monitor). */
  "net.monitors.check": { input: { id: string }; result: NetMonitor };
  "db.connections": { input: null; result: { connections: DbConnection[] } };
  /** Connects and asks the server's version. */
  "db.test": { input: { connection: string }; result: { version: string; ms: number } };
  "db.tables": { input: { connection: string }; result: { tables: DbTable[]; truncated: boolean } };
  "db.query": { input: DbQueryInput; result: DbQueryResult };
  "ssh.keys.list": { input: null; result: { keys: SshKey[] } };
  "ssh.keys.generate": {
    input: { name: string; type: SshKeyType; comment: string };
    result: SshKey;
  };
  /** A public key (one `authorized_keys` line). */
  "ssh.keys.import": { input: { name: string; publicKey: string }; result: SshKey };
  "ssh.keys.update": { input: { id: string; name: string; comment: string }; result: SshKey };
  /**
   * The public key, or (`private: true`, after the person confirms) the private key in OpenSSH
   * format, encrypted with `passphrase` when given.
   */
  "ssh.keys.export": {
    input: { id: string; private: boolean; passphrase?: string | null };
    result: { text: string; fileName: string };
  };
  "ssh.keys.delete": { input: { id: string }; result: null };
}
```

| Operation              | Required app capability |
| ---------------------- | ----------------------- |
| `system.metrics`       | `system:metrics.read`   |
| `system.info`          | `system:metrics.read`   |
| `system.sockets`       | `system:sockets.read`   |
| `system.network`       | `system:network.read`   |
| `system.storage`       | `system:metrics.read`   |
| `system.services`      | `system:services.read`  |
| `logs.query`           | `logs:read`             |
| `disk.usage`           | `storage:usage.read`    |
| `integration.list`     | `integration:*`         |
| `integration.data`     | `integration:*`         |
| `net.http`             | `network:outbound`      |
| `net.dns`              | `network:outbound`      |
| `net.tls`              | `network:outbound`      |
| `net.monitors.list`    | `network:outbound`      |
| `net.monitors.history` | `network:outbound`      |
| `net.monitors.save`    | `network:outbound`      |
| `net.monitors.delete`  | `network:outbound`      |
| `net.monitors.check`   | `network:outbound`      |
| `db.connections`       | `database:connect`      |
| `db.test`              | `database:connect`      |
| `db.tables`            | `database:connect`      |
| `db.query`             | `database:connect`      |
| `ssh.keys.list`        | `secrets:ssh`           |
| `ssh.keys.generate`    | `secrets:ssh`           |
| `ssh.keys.import`      | `secrets:ssh`           |
| `ssh.keys.update`      | `secrets:ssh`           |
| `ssh.keys.export`      | `secrets:ssh`           |
| `ssh.keys.delete`      | `secrets:ssh`           |

System data exposes `source` / capability status where the host cannot provide a measurement.
Distinguish actual host values, explicitly simulated development values and unavailable data in
the interface. Do not convert missing data into a fabricated zero or healthy status.

`logs.query` accepts an exact systemd `unit`, a `priority` threshold (0–7, including more severe
entries), epoch-millisecond `since` / `until`, a case-insensitive **literal** message substring
`grep`, a `limit` of 1–1,000 and an exclusive older-page cursor `before`. Results are newest
first; `hasMore` indicates older matches beyond the page. Preserve the page's `source` when
displaying or exporting records. On Linux, the provider escapes literal search text because
[`journalctl --grep`](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html#-g)
normally interprets it as a regular expression. Query and live-follow sources share this behavior.

Detailed contracts and bounds:

- [Network](network.md): HTTP methods/headers/bodies/timing, DNS records, TLS chains, monitors,
  target allowlists, DNS pinning, redirects, per-person concurrency and failure reasons.
- [Databases](databases.md): configured connection IDs, parameters, table/result types, read-only
  scopes, explicit mutation authorization and query limits. Credentials never enter the app.
- [SSH keys](ssh-keys.md): app/user ownership, supported key types, metadata, public import,
  confirmation for private export, passphrase and deletion.
- [Appearance](appearance.md): the `app.appearance` API, image formats, presets, uploads,
  per-desktop wallpaper and folder icon choices. Appearance methods are window-only.
- [Widgets](widgets.md): manifest declarations, grants, placement and lifecycle.

The SDK exports `NET_LIMITS`, `HTTP_METHODS`, `DNS_RECORD_TYPES`, `DB_LIMITS` and `SSH_KEY_TYPES`.
Use these rather than inventing limits/types in an application. Operation results are exported
types, including `NetHttpResponse`, `NetDnsResult`, `NetTlsResult`, `DbQueryResult`, `SshKey`,
`LogPage`, `DiskUsage` and all `System*` snapshots.

## Internationalization

`createI18n({ locale, supported, fallback?, load? })` loads nested `Messages` and returns:

```ts
export interface I18n {
  readonly locale: string;
  /** BCP 47 tag for Intl formatting (the same regions EveryOS uses). */
  readonly tag: string;
  /**
   * The message for a dotted key, with `{{name}}` placeholders filled. With a numeric `count`,
   * plural forms (`key_one`, `key_other`, … per the language's rules) are chosen. Missing keys fall
   * back to the default language, then to the key itself.
   */
  t(key: string, values?: Record<string, string | number>): string;
  setLocale(locale: string): Promise<void>;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  date(value: number | Date, options?: Intl.DateTimeFormatOptions): string;
}
```

The fallback is English by default. `load` defaults to `packageMessages("locales")`, which loads
`<locale>.json` from the package beside the current document. It does not fetch remote content.
Unsupported locale codes use the fallback. Follow `app.locale.onChange`, await `setLocale` and
render again; a locale event alone does not translate already-rendered text in a vanilla app.

`t` uses dotted keys, `{{name}}` placeholders, and a numeric `count` to select language-specific
plural suffixes (`_one`, `_other`, Russian `_few`/`_many`, etc.). A missing translation falls back
to the fallback language and finally to the key; validate completeness so people never see keys.
Use `number` and `date` with Intl options rather than formatting English text manually. `tag`
provides the SDK's regional BCP 47 tag for an app's own Intl formatter. Interpolated values are
plain text; HTML rendering requires separate sanitization.

## Errors and resource bounds

SDK refusals use `BridgeError` with `code`, `message` and `details` (unknown; validate before use).
`isBridgeError(error, code?)` distinguishes it. Catch ordinary errors as well: text decoding,
application parsing or browser APIs can fail independently of the bridge.

| Code                        | Handling                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ |
| `EVERYOS_PERMISSION_DENIED` | Explain the missing capability; listen for changed grants                      |
| `EVERYOS_CANCELLED`         | End the cancelled picker/dialog workflow quietly                               |
| `EVERYOS_CLOSED`            | The host/instance is gone; stop timers and further calls                       |
| `EVERYOS_TIMEOUT`           | A handshake or operation exceeded its time budget; offer recovery              |
| `EVERYOS_INVALID_REQUEST`   | Fix input/message bounds; do not retry unchanged input indefinitely            |
| `EVERYOS_UNKNOWN_METHOD`    | An unsupported method/context; check SDK compatibility and widget restrictions |
| `EVERYOS_RATE_LIMITED`      | Back off; reduce overlapping bridge requests                                   |
| `EVERYOS_TOO_LARGE`         | Reduce the value/message size or use bounded file chunks                       |

Host/API failures can additionally use codes such as `FORBIDDEN`, `RATE_LIMITED`,
`DESKTOP_APP_NETWORK_BLOCKED` and `DESKTOP_APP_NETWORK_FAILED`; see the domain guides above.
The kit's `errorMessage` and `networkMessage` translate common failures, including how an
administrator can allow a blocked target in the App Store. Never display secrets in error text.

The bridge bounds messages to 1 MiB, file chunks to 512 KiB, storage values to 256 KiB and
concurrent requests to 32. Ordinary requests time out after 60 seconds unless their transport
uses an operation-specific budget; interactive dialogs/pickers wait for input. Server operations
have tighter independent bounds. Large work belongs in a bounded classic worker (kit
`startWorker` / CLI `workers`), with cleanup and time limits. The sandbox has no `unsafe-eval`,
remote scripts or remote network fetches; use approved host operations.

## Working examples and checks

The [four project templates](../../packages/create-everyos-app/) are built, typechecked and
tested by `packages/app-cli/src/cli.test.ts`. Every [official app](../../official-apps/README.md)
uses this same public API. Start with Notes for persistence/widgets, DNS Lookup for network policy
errors, SSL Inspector for TLS, and PDF Viewer for bundling an engine behind a testable interface.

Run `everyos-app validate`, the app's tests and a real installation through the App Store.
Mocks prove app behavior against their configured responses, not production authorization or
sandbox security. [Testing](testing.md), [CLI](cli.md), [manifest](manifest.md) and
[publishing](publishing.md) describe the complete development/distribution workflow.
