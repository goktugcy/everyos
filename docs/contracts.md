# Otuken contracts

This document describes the implemented desktop and window-manager contracts (Phase 2), and planned
widget and catalog contracts. The agent operation contract and HTTP API exist in code and are
summarized at the end.

The Phase 2 source files are authoritative; the later-phase TypeScript definitions are intended
shapes and will be refined alongside implementation.

---

## 1. Desktop application contract (Phase 2)

Every built-in Otuken app (Settings, Docker, Files, Terminal, App Store, …) registers with the
desktop through a static manifest and a lazily imported component. The desktop never imports app
code at startup; it loads an app only when the user opens it (code splitting per app).

```ts
// apps/web/src/desktop/apps/types.ts
export interface DesktopAppManifest {
  id: AppId;
  titleKey: `apps.${keyof Messages["apps"]}`; // i18n key, never a literal title
  icon: LucideIcon; // bundled icon; never a remote URL
  tint: string; // bundled Tailwind gradient classes
  category: "system" | "apps" | "tools" | "settings";
  requiredPermission?: Permission;
  hidden?: boolean;
  keywords?: string[];
  window: {
    defaultSize: { width: number; height: number };
    minSize: { width: number; height: number };
    /** "single": focus the existing window instead of opening a second one. */
    instancing: "single" | "multiple";
  };
  load: () => Promise<{ default: ComponentType }>;
}

// apps/web/src/desktop/apps/app-context.ts
export interface AppHost {
  windowId: string;
  appState: unknown;
  setAppState(state: unknown): void;
  setTitle(title: string): void;
  close(): void;
}
```

**Rules**

- Apps receive host data only through the API client. They never talk to the agent.
- Apps access their host through `AppHostContext` / `useAppHost`. Persisted state goes through
  `setAppState` in the per-user `windows` preference document, debounced to at most one write per
  second. Settings stores its current section; Folder stores its desktop folder id.
- Every action that is reachable by right-click must also be reachable by keyboard and touch (the
  app menu and the command palette).

## 2. Window manager API (Phase 2)

`packages/window-manager` exposes a framework-independent Zustand store. The React binding lives
in `apps/web/src/desktop/state/window-store.ts`. Drag/resize previews paint DOM styles directly on
animation frames; the store receives committed geometry on release, preserving app contents.

```ts
export type WindowId = string;

export interface WindowState {
  id: WindowId;
  appId: string;
  desktopId: string; // virtual desktop
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  layout: WindowLayout;
  minimized: boolean;
  z: number;
  minSize: { width: number; height: number };
  appState?: unknown;
}

export type WindowLayout =
  | "floating"
  | "maximized"
  | "fullscreen"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface WindowManagerActions {
  open(
    spec: WindowSpec,
    options?: { appState?: unknown; desktopId?: string; newInstance?: boolean },
  ): WindowId;
  close(id: WindowId): void;
  focus(id: WindowId): void;
  minimize(id: WindowId): void;
  restore(id: WindowId): void;
  toggleMaximize(id: WindowId): void;
  toggleFullscreen(id: WindowId): void;
  setLayout(id: WindowId, layout: WindowLayout): void;
  setBounds(id: WindowId, bounds: WindowState["bounds"]): void;
  setTitle(id: WindowId, title: string): void;
  setAppState(id: WindowId, state: unknown): void;
  setViewport(viewport: Viewport): void;
  switchDesktop(desktopId: string): void;
  moveToDesktop(id: WindowId, desktopId: string): void;
  mergeDesktop(from: string, into: string): void;
  cycle(direction: 1 | -1): void;
  tile(mode: "columns" | "grid"): void;
  minimizeAll(): void;
  hydrate(session: WindowSession, resolveSpec: (appId: string) => WindowSpec | null): void;
  serialize(): WindowSession;
}
```

**Invariants**

- After every viewport change and every layout restore, each window's title bar must stay at
  least 48 px inside the viewport. Windows can never become unreachable.
- Layouts store pixel bounds plus the original viewport dimensions, so a different display
  resolution maps windows proportionally before clamping. Unknown or forbidden apps are omitted
  during hydration; windows from removed desktops move to the first desktop.
- On narrow viewports (< 768 px) the shell switches to a mobile launcher. There, apps open
  full-screen with a back button, and no overlapping windows exist. Switching shell size does not
  clear the current user's desktop windows.

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

## 5. Implemented contracts (Phases 1–2)

- **HTTP API:** [api.md](api.md).
- **Agent operations:** `packages/agent-protocol/src/operations.ts`. Each operation declares a
  params schema, a result schema, a permission, `allowSystemActor`, a `mutating` flag and a
  timeout. Handlers live in `apps/agent/src/handlers.ts`, and per-operation rules live in
  `apps/agent/src/policy.ts`. Adding an operation means adding all three, plus tests.
- **Error codes:** `packages/shared/src/errors.ts`. Every code must have a translation in every
  locale (enforced by tests).
