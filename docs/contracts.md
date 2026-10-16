# EveryOS contracts

This document describes the implemented desktop and window-manager contracts (Phase 2), and planned
widget and catalog contracts. The agent operation contract and HTTP API exist in code and are
summarized at the end.

The Phase 2 source files are authoritative; the later-phase TypeScript definitions are intended
shapes and will be refined alongside implementation.

---

## 1. Desktop application contract (Phase 2)

Every built-in EveryOS app (Settings, Docker, Files, Terminal, App Store, …) registers with the
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
  second. Settings stores its current section; Files stores its location and view.
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

## 3. Widget platform (Phase 6, implemented)

The complete contract, limits and verification are in [widgets.md](widgets.md). In short:

### 3.1 Widget manifest (versioned)

```jsonc
{
  "schemaVersion": 1,
  "id": "system.diskUsage", // "<provider>.<name>"; i18n key widgets.items.system_diskUsage
  "version": 1, // configuration format; stored instances are migrated on load
  "provider": "system", // system | docker | raspberryPi | ai | built-in integration adapter
  "categories": ["storage"],
  "supportedSizes": ["compact", "small", "medium"], // + "custom" on the desktop
  "defaultSize": "small",
  "placements": ["desktop", "sidebar", "menubar"],
  "permissions": ["system:read"], // required to add the widget and to receive its data
  "requiresCapability": "procfs", // optional
  "dataSources": [{ "topic": "data.storage", "minIntervalMs": 30000 }], // [] for ai.chat
  "config": [{ "key": "mount", "type": "mount", "default": "/" }],
}
```

Manifests live in `packages/widget-sdk/src/manifests.ts` and are validated by
`WidgetManifestSchema`. Configuration UIs and validation are generated from `config`.

### 3.2 Data flow

Collectors run on the server behind **topics**: the stream topics `metrics` and `docker`, the
shared `data.*` topics, and `data.integration.<id>.<feed>`. The browser keeps one SSE connection
per tab (`/api/events?topics=…`) and reference-counts topics with `useTopic`. Data topics arrive as
`event: data` with a `TopicMessage`
(`ok` | `unavailable` with a reason | `error` with a code). The `DataHub` runs one collector per
topic while anyone subscribes and checks permissions per subscriber. Ten CPU widgets in five tabs
cost one collector.

```ts
interface DataProvider {
  topic: string;
  permissions: readonly Permission[]; // all required, checked per subscriber
  intervalMs: number; // the hub never collects more often
  collect(signal: AbortSignal): Promise<ProviderResult>;
  view?: (data: unknown, permissions: ReadonlySet<Permission>) => unknown; // per-subscriber filtering
}
```

### 3.3 Security rule

Catalogs cannot ship widget code. Adapters are matched from deployed image repositories, never
from catalog claims, and remote JavaScript is never imported into the desktop. A future
third-party widget model would run in a sandboxed `<iframe sandbox>` with an explicit,
permission-checked `postMessage` bridge.

- **Credentials** are sealed with the secret box and never sent to the browser.
- **Visibility:** integration data is limited to app managers unless the administrator shares it
  with everyone who can see apps.
- **Failures:** every widget renders inside an error boundary. An offline app shows `app-offline`
  instead of breaking the desktop, and simulated development data is labeled.

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
  | "unpinned-image"
  | "default-secret";
```

### 4.3 Rules

- Placeholders are translated to EveryOS tokens (`$AppID` → `{{app.instanceId}}`,
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

## 5. Implemented contracts (Phases 1–7)

- **HTTP API:** [api.md](api.md).
- **Agent operations:** `packages/agent-protocol/src/operations.ts`. Each operation declares a
  params schema, a result schema, a permission, `allowSystemActor`, a `mutating` flag and a
  timeout. Handlers live in `apps/agent/src/handlers.ts`, and per-operation rules live in
  `apps/agent/src/policy.ts`. Adding an operation means adding all three, plus tests.
- **Error codes:** `packages/shared/src/errors.ts`. Every code must have a translation in every
  locale (enforced by tests).
- **Docker views:** zod-free types/constants in `packages/shared/src/docker.ts`, runtime schemas
  in `packages/shared/src/schemas/docker.ts`. Only SQLite imports establish imported ownership;
  labels are discovery data. See [docker-management.md](docker-management.md).
- **App Store views:** zod-free `CatalogAppView`, `CatalogView`, `InstalledAppView` and
  `AppJobView` in `packages/shared/src/catalogs.ts`; strict request/agent schemas in
  `packages/shared/src/schemas/catalogs.ts`. Metadata, raster assets, architecture variants,
  typed fields, immutable deployed images, durable recovery and data-copy eligibility are included.
  The executable types are authoritative; §4.2 remains the original design sketch. See
  [app-store.md](app-store.md) for the complete current contract and compatibility limits.
- **Widgets:** zod-free constants/types in `packages/shared/src/widgets.ts`, schemas in
  `packages/shared/src/schemas/widgets.ts`, manifests/layout/compatibility helpers in
  `@everyos/widget-sdk`, providers in `apps/api/src/modules/widgets`, integrations in
  `apps/api/src/modules/integrations`. See [widgets.md](widgets.md).
- **Phase 7 tools:** zod-free types in `packages/shared/src/{notifications,files,updates,tasks,
backups,tailscale}.ts` and `cron.ts`; strict request and agent schemas in the matching
  `packages/shared/src/schemas/*.ts` (Tailscale details and peers in `schemas/host.ts`). Backup
  archives are versioned by `manifest.json` (`format: "everyos-backup"`, `version: 1`); the tar
  reader and writer are `@everyos/system/archive`. See [notifications.md](notifications.md),
  [files.md](files.md), [updates.md](updates.md), [tasks.md](tasks.md), [backups.md](backups.md)
  and [tailscale.md](tailscale.md).
