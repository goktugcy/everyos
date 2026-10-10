# Otuken contracts

This document defines the contracts that later phases implement: the desktop application contract,
the window manager API, the widget platform and the catalog adapter interface. The agent operation
contract and the HTTP API already exist in code (Phase 1) and are summarized at the end.

The TypeScript definitions here are the **intended shape**. Implementations may refine them, and
this document is updated in the same change.

---

## 1. Desktop application contract (Phase 2)

Every built-in Otuken app (Settings, Docker, Files, Terminal, App Store, …) registers with the
desktop through a static manifest and a lazily imported component. The desktop never imports app
code at startup; it loads an app only when the user opens it (code splitting per app).

```ts
// packages/desktop/src/app-registry.ts
export interface DesktopAppManifest {
  id: string; // "otuken.docker" — stable, used in layouts and deep links
  titleKey: TranslationKey; // i18n key, never a literal string
  icon: IconRef; // built-in icon id or bundled asset; never a remote URL
  category: "system" | "apps" | "tools" | "settings";
  /** Permission needed to see the app at all (UI hint; the API enforces it independently). */
  requiredPermission?: Permission;
  /** Capability the host must provide (e.g. "docker"); otherwise the app explains why it is unavailable. */
  requiredCapability?: CapabilityId;
  window: {
    defaultSize: { width: number; height: number };
    minSize: { width: number; height: number };
    resizable: boolean;
    /** "single": focus the existing window instead of opening a second one. */
    instancing: "single" | "multiple";
  };
  /** Commands shown in the app menu, dock menu and global search. */
  commands?: AppCommand[];
  load: () => Promise<{ default: ComponentType<DesktopAppProps> }>;
}

export interface DesktopAppProps {
  windowId: WindowId;
  /** Opaque, serializable state restored with the layout (e.g. current folder). */
  initialState?: unknown;
  setWindowState(state: unknown): void; // persisted, debounced
  setTitle(title: string): void;
  setBadge(count: number | null): void; // dock badge
}

export interface AppCommand {
  id: string;
  titleKey: TranslationKey;
  shortcut?: string; // "Mod+Shift+T"
  requiredPermission?: Permission;
  run(ctx: CommandContext): void | Promise<void>;
}
```

**Rules**

- Apps receive host data only through the API client. They never talk to the agent.
- App state that must survive a reload goes through `setWindowState`, which persists it in the
  per-user layout (`user_preferences`, key `desktop.layout`), debounced to at most one write per
  second.
- Every action that is reachable by right-click must also be reachable by keyboard and touch (the
  app menu and the command palette).

## 2. Window manager API (Phase 2)

`packages/window-manager` is framework-light state plus thin React bindings. Window geometry lives
in a Zustand store that is updated with transient subscriptions during drag and resize, so moving a
window re-renders only that window frame and never the app contents.

```ts
export type WindowId = string;

export interface WindowState {
  id: WindowId;
  appId: string;
  desktopId: string; // virtual desktop
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  mode: "normal" | "minimized" | "maximized" | "fullscreen" | { snapped: SnapZone };
  z: number;
  appState?: unknown;
}

export type SnapZone = "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface DesktopController {
  openApp(appId: string, options?: { state?: unknown; desktopId?: string }): WindowId;
  openWindow(appId: string, options?: { state?: unknown }): WindowId; // forces a new instance
  focusWindow(id: WindowId): void;
  minimizeWindow(id: WindowId): void;
  maximizeWindow(id: WindowId): void;
  restoreWindow(id: WindowId): void;
  toggleFullscreen(id: WindowId): void;
  snapWindow(id: WindowId, zone: SnapZone): void;
  tileWindows(desktopId: string, layout: "columns" | "grid"): void;
  moveWindow(id: WindowId, bounds: Partial<WindowState["bounds"]>): void;
  closeWindow(id: WindowId): void;
  cycleWindows(direction: 1 | -1): void; // Alt+Tab equivalent
}
```

**Invariants**

- After every viewport change and every layout restore, each window's title bar must stay at
  least 48 px inside the viewport. Windows can never become unreachable.
- Layouts are stored in relative units, so a different display resolution maps windows
  proportionally before the clamp is applied.
- On narrow viewports (< 768 px) the shell switches to a mobile launcher. There, apps open
  full-screen with a back gesture, and no overlapping windows exist.

## 3. Widget platform (Phase 6)

### 3.1 Widget manifest (versioned)

```jsonc
{
  "schemaVersion": 1,
  "id": "system.cpu", // "<provider>.<name>"
  "version": "1.0.0",
  "provider": "system", // built-in provider or an installed app integration id
  "titleKey": "widgets.system.cpu.title",
  "supportedSizes": ["small", "medium", "large"],
  "placements": ["desktop", "sidebar", "menubar"],
  "permissions": ["system:read"],
  "dataSources": [{ "topic": "metrics.cpu", "minIntervalMs": 2000 }],
  "configSchema": { "type": "object", "properties": { "showPerCore": { "type": "boolean" } } },
  "requiresCapability": "procfs",
}
```

### 3.2 Data flow

Widget rendering and data collection are separate. Collectors run on the server and publish to
**topics**. The client keeps a single SSE connection per tab and multiplexes topic subscriptions
over it. Ten CPU widgets cost one collector and one stream, not ten polls.

```ts
// server side (API): one collector per topic, reference-counted by subscribers
export interface TopicProvider<T> {
  topic: string; // "metrics.cpu", "docker.containers", "app.jellyfin.sessions"
  permission: Permission; // checked per subscriber
  minIntervalMs: number; // lower bound enforced server side
  collect(signal: AbortSignal): Promise<T>;
}

// client side
export function useTopic<T>(topic: string, options?: { intervalMs?: number }): TopicState<T>;
export type TopicState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T; at: number }
  | { status: "unavailable"; reason: CapabilityReason | "app-offline" | "not-configured" }
  | { status: "error"; code: ErrorCode };
```

### 3.3 Security rule

Catalogs can **declare** that an app supports a built-in widget adapter (for example
`"widgets": [{ "adapter": "jellyfin.sessions" }]`). They cannot ship executable widget code.
Remote JavaScript is never imported into the desktop. A future third-party widget model would run
in a sandboxed `<iframe sandbox>` with an explicit, permission-checked `postMessage` bridge.
Credentials for application APIs are stored with the secret box and never sent to the browser.
Every widget renders inside an error boundary, and an offline app shows the `app-offline` state
instead of breaking the desktop.

## 4. Catalog adapters (Phase 5)

The format research is in [research/catalog-formats.md](research/catalog-formats.md). Key facts
that shape this contract:

- CasaOS/ZimaOS (179 apps, Apache-2.0) and Big Bear (466, MIT) share the compose + `x-casaos`
  format. ZimaOS also publishes a static v2 index with per-architecture compose files.
- Runtipi (270 apps) is GPL-3.0, so its content is fetched at runtime on the user's machine and
  never bundled. Its `docker-compose.json` is authoritative over the legacy YAML.
- Coolify templates (Apache-2.0) depend on "magic" `SERVICE_*` variables that need generators.
- Roughly 9–18 % of apps in each catalog request a high-risk setting: privileged mode, host
  network, the Docker socket, or sensitive host paths.

### 4.1 Adapter interface

```ts
export interface CatalogAdapter {
  format: "casaos-v2" | "casaos-source" | "runtipi" | "coolify" | "portainer" | "compose-dir";
  /** Cheap, side-effect-free detection on an archive listing plus a few small files. */
  detect(source: CatalogSourceView): Promise<DetectionResult>;
  /** Parses into normalized manifests. Must not execute anything from the catalog. */
  parse(source: CatalogSourceView, context: ParseContext): AsyncIterable<ParseOutcome>;
}

export interface CatalogSourceView {
  /** Paths relative to the archive root (top-level "<repo>-<ref>/" stripped). */
  list(): string[];
  /** Size-capped read (default 256 KiB); rejects symlinks and path traversal. */
  read(path: string): Promise<Buffer>;
  sourceRef: string; // commit SHA or v2 content hash
}

export type ParseOutcome =
  { kind: "app"; manifest: NormalizedApp } | { kind: "skipped"; nativeId: string; reason: string }; // surfaced in the catalog details UI
```

Detection order, from most to least specific: v2 store JSON → Runtipi (`config.json` with
`tipi_version`) → Coolify header → CasaOS `x-casaos` → Portainer → Umbrel (rejected, license) →
plain compose directory.

### 4.2 Normalized application model

```ts
export interface NormalizedApp {
  id: string; // "<catalogId>:<nativeId>"
  logicalKey: string; // duplicate-detection key (image repository + normalized name)
  name: LocalizedText;
  description: LocalizedText;
  icon: AssetRef | null; // proxied/cached by the API; never hot-linked by the browser
  screenshots: AssetRef[];
  categories: string[];
  source: { catalogId: string; format: CatalogAdapter["format"]; ref: string; path: string };
  version: string | null;
  architectures: { declared: Arch[] | "unknown"; verified?: Arch[] };
  ports: Array<{
    container: number;
    host?: number;
    protocol: "tcp" | "udp";
    role: "web" | "other";
    userEditable: boolean;
  }>;
  volumes: Array<{
    target: string;
    kind: "appData" | "userData" | "hostPath" | "named";
    hostPathTemplate?: string;
  }>;
  environment: Array<{
    key: string;
    default?: string;
    required: boolean;
    secret: boolean;
    userEditable: boolean;
    generator?: SecretGenerator;
  }>;
  dependencies: string[];
  requiredCapabilities: RiskFlag[]; // derived from compose, never from catalog claims
  images: Array<{ ref: string; tag: string | null; digest: string | null }>;
  healthCheck: boolean;
  installMethod: "compose";
  links: { documentation?: string; website?: string; repository?: string };
  preInstallNotes?: LocalizedText;
  widgets?: Array<{ adapter: string }>;
  /** The original compose document after placeholder translation, kept verbatim for provenance. */
  compose: string;
}

export type RiskFlag =
  | "privileged"
  | "host-network"
  | "host-pid"
  | "docker-socket"
  | "sensitive-host-path"
  | "devices"
  | "cap-add"
  | "security-opt-unconfined"
  | "unpinned-image";
```

### 4.3 Rules

- Placeholders are translated to Otuken tokens (`$AppID` → `{{app.instanceId}}`,
  `${APP_DATA_DIR}` → `{{paths.appData}}`, `SERVICE_PASSWORD_*` → `{{secret.generate}}`, …).
  **Unknown variables block installation** until the user provides a value. They are never
  resolved from the host environment.
- Risk flags are derived from the compose document itself; catalog metadata cannot downgrade them.
  The install policy decides per flag whether to allow, warn, or block (blocking requires an
  explicit administrator override).
- A failed synchronization keeps the last valid snapshot. Disabling or removing a catalog never
  touches installed apps; installation provenance (catalog, ref, path, compose) is stored with
  the installed app.
- Fetching uses an SSRF-safe client: http(s) only, public addresses only unless allowed
  explicitly, redirects re-validated, plus size and time limits.

## 5. Implemented contracts (Phase 1)

- **HTTP API:** [api.md](api.md).
- **Agent operations:** `packages/agent-protocol/src/operations.ts`. Each operation declares a
  params schema, a result schema, a permission, `allowSystemActor`, a `mutating` flag and a
  timeout. Handlers live in `apps/agent/src/handlers.ts`, and per-operation rules live in
  `apps/agent/src/policy.ts`. Adding an operation means adding all three, plus tests.
- **Error codes:** `packages/shared/src/errors.ts`. Every code must have a translation in every
  locale (enforced by tests).
