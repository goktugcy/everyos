# App SDK architecture

This document specifies how third-party and official **desktop apps** run inside EveryOS: the
isolation model, identities, the bridge protocol, packages, registries, the server API, storage and
the release gates. It is the plan of record for the `feature/app-sdk` branch; the feature ships in
one public release once every gate in [the acceptance report](../sdk-release-acceptance.md) passes.

## Goals and non-goals

- A developer builds a static web app with `@everyos/app-sdk`, packs it as `.eosapp`, signs it and
  publishes it from their own infrastructure or the community registry, without write access to
  this repository.
- A user installs it from the App Store next to Docker apps and uses it in an EveryOS window or as a
  widget, with data that persists, is isolated per user and per app, and is backed up.
- Untrusted app code never runs in the desktop origin, never sees the session, and reaches host data
  only through capabilities that the **server** authorizes per request.
- Non-goals: native code, install scripts, server-side app code, raw host management, a generic HTTP
  proxy, a second privileged agent, a second database.

## App classes

| Class   | Runs                                                                  | Installed by                       | Model                                               |
| ------- | --------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| Docker  | Compose project on the host (unchanged, [App Store](../app-store.md)) | `apps:manage`                      | catalogs, adapters                                  |
| Desktop | Static bundle in a sandboxed frame                                    | `apps:manage` (system-wide)        | this document                                       |
| Hybrid  | Desktop frontend + a Docker or external backend                       | both models, linked by integration | backend reached only through an integration adapter |

A hybrid app never inherits backend privileges: its frontend talks to the backend only through an
`integration:<adapter>` capability that the existing integration security model serves (credentials
stay sealed on the server, requests go through the SSRF-safe client).

## Isolation model

The owner usually opens EveryOS by IP over plain HTTP. A second port is not cookie-isolated and a
bare IP has no subdomains, so isolation must not depend on a second origin. Apps therefore run in an
**opaque origin**:

- Each app window (and each third-party widget) is an
  `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads">` **without
  `allow-same-origin`**. The frame cannot read the desktop's DOM, storage or cookies, cannot navigate
  the top window, and its `fetch` to EveryOS is cross-origin (no readable responses, no CSRF token).
- Its document comes from a **capability URL** `/app-runtime/<runtimeKey>/<path>`: `runtimeKey` is a
  random 128-bit key per installed version. Runtime files carry no session requirement (the opaque
  frame's subresource requests must not depend on cookies), only installed package content, and:
  - `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups
allow-downloads; default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'
'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:;
worker-src 'self' blob:; connect-src 'self'; form-action 'none'; base-uri 'none';
frame-ancestors 'self'` — the `sandbox` directive keeps the document opaque even when opened
    directly; no remote scripts, styles or connections are possible.
  - `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Resource-Policy: cross-origin` and
    `Access-Control-Allow-Origin: *` (module scripts from an opaque origin are CORS requests).
- The desktop's own CSP gains `frame-src 'self'`, so app frames can only ever (re)navigate to
  EveryOS URLs; everything else keeps `X-Frame-Options: DENY` / `frame-ancestors 'none'`.
- **API hardening first:** every `/api` request (including GET) must carry `Sec-Fetch-Site:
same-origin` or `none` when the browser sends the header, so an opaque frame cannot trigger
  side-effecting GETs (such as `files/download?discard=true`) with the user's cookies.
- Large media and file reads use **file capability URLs** (`/app-files/<token>`): short-lived,
  single-item, read-only, `Range`-capable, issued by the server for a granted file handle.

Opaque origins have no `localStorage`, IndexedDB or cookies; apps persist through the Storage API.
Plain-HTTP pages are not a secure context, so signatures are always verified on the server.

## Identities

| Identity     | What                                                                  | Who enforces                       |
| ------------ | --------------------------------------------------------------------- | ---------------------------------- |
| Publisher    | reverse-DNS id (`dev.everyos`, `io.github.alice`) + Ed25519 key(s)    | registry index, signed             |
| Application  | `appId` = `<publisherId>.<name>`                                      | manifest + publisher namespace     |
| Package      | `appId@version` + SHA-256 + publisher signature                       | installer                          |
| Installation | one per `appId` per server; granted permissions; `runtimeKey`         | API (`desktop_app_installations`)  |
| Instance     | one running window or widget; random token bound to session + install | API (in memory, expires with both) |
| User         | the authenticated EveryOS session; role permissions                   | existing auth                      |

`dev.everyos.*` is reserved for the official registry. A registry may only list an app whose
`appId` starts with a publisher id that the registry's signed index assigns to the signing key; two
registries claiming the same `appId` are a conflict the store shows, never silently resolved. A
self-declared "official" flag means nothing: official is the pinned official registry key.

## Bridge protocol (v1)

1. The desktop creates a `MessageChannel` per instance and, on the frame's first `load`, posts
   `{ type: "everyos:init", protocol: 1 }` with one port to `frame.contentWindow` (target `*`: the
   frame's origin is opaque; `frame-src 'self'` and capability URLs bound what can be there). It
   sends a port exactly once per instance.
2. The SDK accepts only the first `everyos:init` whose `event.source === window.parent`, keeps the
   port and stops listening on `window`.
3. Requests are `{ id, method, params }`; responses `{ id, ok, result | error: { code, message } }`;
   host events `{ event, data }` (theme, locale, visibility, lifecycle, permission changes).
4. The desktop validates every message by hand-written validators (the browser bundle stays
   zod-free): known method, params shape, size (64 KiB default, chunked file transfer), rate (token
   bucket per instance), in-flight limit and timeout. Unknown or malformed messages are dropped and
   counted; repeated abuse closes the instance.
5. The desktop forwards privileged calls to `/api/app-sdk/*` with the session (it is first-party)
   plus `X-EveryOS-App-Instance: <token>`. The server resolves the token to installation + user and
   authorizes **each call**: method → capability, capability granted to the installation, and the
   user's role permissions allow it. A manifest permission is a request, never an authorization.

Window, theme, dialog and clipboard methods are served by the desktop itself (no host data). The
clipboard write runs in the desktop document on a user gesture that started in the frame (user
activation propagates to ancestors).

## Capabilities

| Capability                  | Grants                                                        | Also requires (user role)    |
| --------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `storage:app`               | per-user, per-app key-value storage within a quota            | —                            |
| `files:pick` / `files:save` | items the user picks in the EveryOS picker (scoped handles)   | `files:read` / `files:write` |
| `notifications:send`        | app notifications, rate-limited, per-app user preferences     | —                            |
| `clipboard:write`           | user-initiated copy                                           | —                            |
| `widgets:register`          | the widgets declared in the manifest                          | —                            |
| `system:metrics.read`       | metrics, uptime, storage summary (existing data hub topics)   | `system:read`                |
| `system:sockets.read`       | listening sockets (`network.sockets`)                         | `system:read`                |
| `system:network.read`       | interfaces, routes, DNS configuration                         | `system:read`                |
| `logs:read`                 | journald via the existing logs API                            | `logs:read`                  |
| `storage:usage.read`        | bounded directory sizes inside the user's file roots          | `files:read`                 |
| `network:outbound`          | HTTP/DNS/TLS to targets on the admin allowlist only           | `apps:manage` grants per app |
| `database:connect`          | saved connections via the server connector, read-only default | `apps:manage` grants per app |
| `secrets:ssh`               | the user's own SSH key store (sealed)                         | —                            |
| `integration:<adapter>`     | a hybrid app's configured integration                         | `apps:read`                  |

Risky capabilities (`network:outbound`, `database:connect`) need an explicit administrator grant at
install and on every update that adds them; an update that requests a new capability stays pending
until approved. No capability exposes Docker, systemd control, shells or arbitrary paths.

The **network access policy** is an administrator setting: host-name rules (public addresses only)
and address-range rules (private networks, this server), each with its ports, for all apps or one
app. HTTP, TLS inspection, DNS and HTTP monitors run on the server; every target and redirect hop is
resolved, checked and pinned, link-local and metadata addresses are always refused, and EveryOS
cookies and credentials are never sent. See [network access](network.md).

**Databases** are connected by administrators in EveryOS (credentials sealed, never given to an app);
apps run one statement at a time, read-only unless the connection allows changes and the person
confirms each change in a dialog the desktop draws. See [databases](databases.md).

**SSH keys** belong to each person and are sealed on the server; a private key leaves only through an
export the person confirms in a dialog the desktop draws, and file access never reaches `.ssh`
secrets. See [SSH keys](ssh-keys.md).

## Manifest

`manifest.json` (`manifestVersion: 1`), validated with zod on the server and in the CLI
(`@everyos/app-manifest`): `id`, `name`, `version` (semver), `description`, `entry`, `icon`,
`category`, `permissions` (each with a localized reason), `window` (`defaultWidth`, `defaultHeight`,
`minWidth`, `minHeight`, `instances`), `widgets` (id, entry, sizes, placements, permissions),
`locales` (supported languages, default `en`, message files), `minEveryOS`, `sdk` (compatible SDK
range), `publisher` (id, name, url), `license`, `homepage`, `integration` (hybrid only). Unknown
keys are rejected; strings and counts are bounded.

## Packages (`.eosapp`)

A gzip-compressed ustar archive (read with the existing bounded reader in `@everyos/system/archive`,
which rejects absolute paths, `..`, links and oversized entries) containing `manifest.json`, the
entry document and static assets. Limits: 64 MiB packed, 256 MiB unpacked, 10 000 entries, 255-byte
names. Allowed file types are static web assets (no executables are made executable; nothing is run
on the host). Distribution metadata carries `sha256`, `size` and an Ed25519 signature by the
publisher key over `{appId, version, sha256, size}`.

Install is transactional: download to a staging file → size and hash check → signature against the
registry's publisher key → unpack into `<dataDir>/desktop-apps/staging/<id>` with limits → validate
the manifest (id, version, permissions, compatibility) → atomic rename to
`<dataDir>/desktop-apps/<appId>/<version>/` → database row. The app appears only after the row is
committed. Updates keep the previous version until the new one is active, so a failed update rolls
back; uninstall removes files, storage, grants and widgets after confirmation. The installed
`.eosapp` is kept so backups and restores do not depend on the registry.

## Registries

A registry is an HTTPS (or allowlisted HTTP) URL serving a signed index (`{payload, signature}`, the
release-signing pattern with its own schema): registry id and name, publishers with their keys and
namespaces, apps with versions (manifest summary, package URL, size, SHA-256, publisher signature,
changelog, screenshots), revocations, `publishedAt`, `expiresAt`.

- **Official:** key pinned in the build (and overridable only by root-owned configuration, like the
  release key); enabled by default; the only source of `dev.everyos.*`.
- **Community:** the Cloudflare-hosted community registry (below), added by default but disabled
  until an administrator enables it; shows community badges.
- **Private:** any registry an administrator adds with its key fingerprint; optional bearer token
  sealed with `SecretBox`.

Refresh is periodic and on demand, size-bounded and SSRF-safe; a revoked package is disabled on every
server that syncs the index and the store explains why.

## Community registry service

`services/community-registry/` is a Cloudflare Worker with D1 (developers, apps, versions,
submissions, reviews, reports, revocations) and R2 (packages, screenshots, the signed index).
Developers register with a verified e-mail address and their publisher key, submit packages through
the CLI or a web form (no pull requests), get automated checks (manifest, structure, limits,
signature, CSP-relevant scans) and a human review, then publication signs a new index with the
registry key (a Worker secret). Updates, revocations and abuse reports use the same service. It is
deployed to the owner's Cloudflare account only with the owner's explicit approval.

## Server API

`/api/desktop-apps/*` (store and management: registries, catalog, install, update, permission
approvals, uninstall, per-user settings) and `/api/app-sdk/*` (instance calls: storage, files,
notifications, metrics, logs, network, database, SSH keys, widgets). Every route validates with zod
and checks a permission; installs, updates, grants, revocations, uninstalls, network rules, monitors
and refused network targets are audited without secrets (individual requests are not, so an app
cannot flood the audit log).

Tables (migration 0016, append-only): `desktop_app_registries`, `desktop_app_catalog`,
`desktop_app_installations`, `desktop_app_storage`, `desktop_app_file_grants`,
`desktop_app_user_settings`, `desktop_app_network_rules` (0018: per-app rules),
`desktop_app_monitors`, `desktop_app_monitor_checks`, `desktop_app_db_connections` (0019),
`desktop_app_ssh_keys` (0020), with foreign keys, unique constraints and per-user isolation.

## Desktop integration

Installed desktop apps become dynamic `DesktopAppManifest` entries (`everyos.desktop.<appId>`) whose
window renders the sandboxed frame host; dock, launcher, mobile shell, window state restore and
widgets accept them. Third-party widgets render in the same kind of frame inside the widget frame and
activate lazily. The App Store gains type, source and status filters and a detail page with
permissions, publisher, versions and storage use.

## Official apps and developer tooling

- `official-apps/<name>/`: the 33 official apps, each a workspace package built with
  `@everyos/app-sdk` and the shared `@everyos/app-ui` kit, packed and signed by CI with the official
  key, listed in the official registry.
- `packages/app-cli` (`everyos-app dev | build | validate | pack | sign | test | publish`) and
  `packages/create-everyos-app` (vanilla TS, React, React + widget, hybrid templates);
  `packages/app-testing` (a clearly labelled mock host for unit tests, plus helpers to run against a
  real developer instance).

## Backups and updates

The database snapshot carries installations, grants, settings, storage and registries; backups add
the installed `.eosapp` files. Restore re-verifies each package's hash and publisher signature
before activating it; a package that cannot be verified is restored disabled with an explanation.

## Release gates

CI adds SDK, package, registry, security and per-app test jobs on amd64 and arm64, builds and
validates all 33 packages, and writes a machine-readable release report (app, id, version,
checksum, manifest, build, tests, localization completeness, permission review). The release fails
if any official app is missing, broken, incompatible or unsigned.
