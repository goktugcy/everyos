# Architecture decision log

Short records of decisions that are not obvious from the code. Newest last.

## D1 — Node.js 26 as the runtime (2026-10)

**Decision:** Target Node.js 26. It becomes LTS on 2026-10-28 and is supported until 2029-04-30.
The `.deb` package will ship its own Node runtime under `/usr/lib/everyos/node`.
**Why:** Distribution Node packages are too old and vary across Ubuntu/Debian releases. Node 26
gives us `node:sqlite` as a release candidate, built-in TypeScript type stripping, and long
support. Node 24 leaves active LTS on 2026-10-20.
**Consequence:** contributors need Node 26 (`.node-version`).

## D2 — `node:sqlite` instead of better-sqlite3

**Decision:** Use the built-in `node:sqlite` (stability 1.2, release candidate since v25.7), wrapped
by `@everyos/database`.
**Why:** It removes the only native addon. Otherwise we would need per-architecture, per-ABI
prebuilt binaries in CI and in the package. It also provides online backups (`backup()`), which
the pre-migration backup uses.
**Escape hatch:** all SQL goes through the `Database` class, so switching to better-sqlite3 is
contained in one package.

## D3 — No transpiler in development; esbuild bundles for production

**Decision:** Development runs `.ts` directly with Node type stripping (`erasableSyntaxOnly`).
Production bundles `apps/api` and `apps/agent` into single ESM files with esbuild.
**Why:** It needs fewer dev dependencies (no tsx/ts-node), and the deployable artifacts are two
files plus static assets with no `node_modules` on the server. That makes ARM64/AMD64 packaging
trivial.

## D4 — TypeScript 6.0, not 7

**Decision:** Pin TypeScript 6.0.x.
**Why:** typescript-eslint (type-aware linting) supports `typescript <6.1`. TypeScript 7 (the Go
port) does not yet expose the compiler API that linters need. Revisit when typescript-eslint
supports it.

## D5 — scrypt for password hashing

**Decision:** Use scrypt from `node:crypto` with N=2¹⁶, r=8, p=2 in a self-describing hash format
that supports rehashing.
**Why:** It is OWASP-recommended, needs no native dependency, and runs in libuv's thread pool, so
it does not block the event loop. Argon2id would need a native addon; `crypto.argon2` in Node is
still experimental. The hash format allows migrating to Argon2id later.
**Measured cost:** each verification temporarily allocates about 64 MiB, which is released
afterwards (API RSS 72 → 139 → 75 MiB measured on an M2 dev machine).

## D6 — Agent protocol: NDJSON over a Unix socket with a mutual HMAC handshake

**Decision:** Use newline-delimited JSON frames (1 MiB maximum), a typed operation registry
validated with zod on both ends, and a challenge–response with a shared key.
**Why:** Node cannot read `SO_PEERCRED`. Socket permissions and possession of the group-readable
key together give group-level peer identity without a native addon. JSON keeps the protocol
debuggable. A generic "exec" operation is deliberately excluded.

## D7 — The API owns host-independent work; the agent owns privileged and host introspection work

**Decision:** The API never reads privileged host interfaces or the Docker socket. The agent
collects host information (Phase 1) and will perform privileged operations (Phase 3+).
Unprivileged high-frequency metrics may later be read by the API directly if measurements show
the extra hop matters.
**Why:** It keeps one clear privilege boundary.

## D8 — Zod-free browser contracts

**Decision:** The root entry of `@everyos/shared` contains only types and constants. Zod schemas
live in `@everyos/shared/schemas`.
**Why:** The schemas are top-level side-effectful calls that bundlers cannot tree-shake. Importing
them pulled about 90 KB (minified) of zod into the web client. The initial web chunk is now
329 KB raw / 105 KB gzip.

## D9 — First-run setup token

**Decision:** Creating the first account requires a token from
`/var/lib/everyos/setup-token` (0600).
**Why:** It prevents anyone on the network from claiming a fresh instance before its owner (the
same pattern as Jenkins and Grafana's admin bootstrap). In development the token is also printed
to the console.

## D10 — Turkish default UI language

**Decision:** The UI defaults to Turkish regardless of the browser language. The last choice on a
device (local storage) applies before sign-in, and the user's saved preference applies after.
**Why:** This is a product requirement. Browser negotiation would silently show English to most
users.

## D11 — Desktop ownership and client persistence (2026-10)

Desktop preferences and wallpapers use `preferences:manage`, available to every role for its own
account. The API takes ownership only from the authenticated session. This does not grant viewers
host mutations or instance configuration rights. Security preference edits and wallpaper deletion
are audited. Session locking is enforced by the API, with explicit read exceptions needed to
render the lock screen after a reload.

Preference writes are serialized per document and debounced. Logout waits for in-flight writes;
failed writes are retried only within the same signed-in session. UI resets save defaults through
that queue rather than racing a DELETE against an earlier PUT. A failed load shows an error and
retry control, preserving saved user data.

The reusable theme and window state engines live in packages. Desktop-specific React UI remains
under `apps/web/src/desktop`; glass primitives stay in `apps/web/src/components/ui` until a second
consumer justifies extracting `packages/ui`. The earlier package-extraction milestone is deferred,
not represented by an empty workspace package. Dock badges and capability-gated future app
manifests remain future extensions; no placeholder apps are registered.

## D12 — Raw counters in the agent, rates and history in the API (2026-10)

The agent returns raw cumulative counters (`/proc/stat`, `/proc/net/dev`, `/proc/diskstats`) and
instantaneous values. The API derives rates from consecutive samples. This keeps agent operations
stateless and cacheable, lets one sample serve every subscriber, and keeps all retention logic in
the unprivileged process. Fast (2 s) sampling runs only while someone watches; a 60 s background
sampler feeds 24 h of minute averages in memory. Persistent history (SQLite) is deferred until a
widget or alert needs it, to avoid write amplification on SD cards.

## D13 — systemctl/journalctl JSON output instead of D-Bus bindings (2026-10)

Native D-Bus bindings would require a compiled addon or a large dependency. `systemctl
--output=json`, `systemctl show --timestamp=unix` and `journalctl --output=json` are stable,
machine-readable interfaces on every supported distribution (systemd ≥ 248 for JSON unit lists).
They run through the agent's restricted `execFile` helper, never a shell. Revisit if per-call
process start-up cost shows up in Raspberry Pi measurements.

## D14 — Development simulator for systemd and journald (2026-10)

macOS development machines and CI need deterministic service and log data. A simulator implements
the same interfaces in memory and is selected only in development (automatically when the tool is
missing, or with `EVERYOS_AGENT_SIMULATE=1`). Every simulated response carries
`source: "simulated"`, which the UI labels, and the agent refuses the variable in production.
Metrics, storage and processes are never simulated; on macOS they are real readings with
Linux-only fields reported as unavailable.

## D15 — One multiplexed SSE stream per tab (2026-10)

Server-sent events instead of WebSockets: one-way server → browser is all live metrics and logs
need, they work through every reverse proxy and `tailscale serve`, reconnect automatically, and
reuse cookie authentication and the CSRF model unchanged. Topics are multiplexed on one
`/api/events` connection to stay within browsers' per-origin connection limits; log tails are a
separate stream because they carry per-viewer filters.

## D16 — Docker discovery does not establish ownership (2026-10)

Use the Engine API through the agent for discovery, detail, lifecycle, stats and logs. Container
labels are untrusted metadata, so explicit Compose imports in SQLite are the only source of
imported ownership. Managed ownership is reserved for the Phase 5 installer. External containers
have a limited lifecycle action set; project actions require import and revalidate the recorded
local Compose files. Existing host configuration remains the owner's responsibility. No automatic
cleanup or prune is introduced.

Compose uses its CLI to preserve existing host files, environment files and multi-file projects.
The agent uses fixed argument arrays, minimal environment and the same explicit Unix socket as
discovery. Only start is allowed for a project containing a protected container: up/update may
recreate services and therefore cannot bypass protection.

## D17 — Bounded catalog data and stdin-based managed Compose (2026-10)

Catalog readers consume bounded HTTP and in-memory ZIP data instead of cloning/executing upstream
repositories. Every redirect resolves and pins a validated public address unless the administrator
explicitly grants private-source access. Snapshots replace data atomically and never own installed
applications. Unsupported templates/features are visible outcomes rather than guessed conversions.

Managed applications use a UUID project namespace, a private agent-owned ownership marker, and
configuration encrypted in SQLite with a per-instance SecretBox context. Compose receives the
configuration through stdin so decrypted secrets never require a persistent or temporary file.
The mutation is a typed unary operation; a separate authenticated read-only SSE stream reports the
API job state. Initial failure rolls back only that namespace while preserving all data and images.
Updates do not yet provide application-data rollback.

Do not heuristically replace fixed upstream password literals with independent random values:
multiple services and connection strings may rely on the same literal. Preserve the source's
relationships and require acknowledgement of a fixed-credential warning. Declared generators are
supported explicitly; secret-valued interpolation defaults require user input. Port edits retain
the source's host-IP binding instead of broadening loopback-only exposure.

## D18 — Durable managed deployments and bounded compatibility (2026-10)

Resolve images for the host architecture and seal the pinned deployment separately at the agent,
using a key derived from its persistent IPC key. Updates pull before changing services and restore
the previous artifact after an unhealthy `up`. This restores images/configuration, not application
database changes. Initial failure/removal never deletes app data, volumes or images.

Persist root-owned install intent and terminal job identity. Reconciliation matches the exact API
job after interruption and does not infer success from running containers. All managed lifecycle
paths share project locks, including generic Docker controls and the source of a data copy.

Normalize embedded Coolify configuration into bounded, fixed-name read-only files on verified
root-private tmpfs; durable content remains sealed. Keep proxy/DNS/TLS configuration owner-managed.
Swarm, Windows, builds/hooks and external files are explicit unsupported outcomes of the standalone
Linux Compose contract. Use RE2 for untrusted catalog field constraints. Copy only stopped owned
app-data files/directories, with entry/byte bounds and no links or special files.

Verified with a root agent, UID 1000 API and real Docker in a dedicated ARM64 Linux VM. See
[app-store.md](app-store.md) and [phase5-acceptance.json](phase5-acceptance.json).

## D19 — Built-in widgets on shared server topics (2026-10)

Widgets are built-in manifests and renderers. Catalog entries can only be matched to built-in
adapters by deployed image repository, so app data reaches the desktop without executing remote
code. A sandboxed third-party widget model is deferred, and would need its own permission bridge.

Data is collected on the server behind reference-counted topics, multiplexed on the existing SSE
stream (D15) as `event: data`. This was chosen over per-widget polling: N widgets in M tabs cost
one collector, permissions are enforced per subscriber with per-subscriber views, and an app being
offline is a state, not an exception. Collectors exist only while someone is subscribed.

App integrations are explicit administrator consent, with sealed write-only credentials, a
managers-only default audience, and an SSRF-checked client that allows LAN/loopback but never
link-local/metadata addresses and never follows redirects. Feeds minimize data in the API rather
than in the browser.

Layouts are a per-user preference document. Desktop widgets use a coarse 80 px grid that refuses
overlaps. When the work area shrinks, an effective layout moves widgets to free cells, and the
saved layout adopts it on the next change. Widgets on missing virtual desktops move to the first
one, like windows.

## D20 — Notifications as conditions and events in SQLite (2026-10)

Problems that last (a failed service, a full disk) are conditions that are raised and resolved,
while results (an install, a backup) are deduplicated events. Both live in SQLite with per-user
read and dismiss state, and visibility follows each kind's permission. Delivery reuses the
per-tab SSE stream (D15). External channels plug in through a provider interface. A message
queue or a separate notification service was not justified for one host.

## D21 — Files in the API's identity, update and scheduler jobs in the background (2026-10)

The file manager runs in the unprivileged API, so the operating system stays the final boundary
and the root agent never touches user files. Package jobs and scheduled tasks run as background
jobs independent of HTTP requests, one update job at a time. Scheduled tasks are a closed set of
predefined actions, and every run re-checks the owner's current permissions instead of storing
a capability at creation time.

## D22 — Backups as checksummed directories, restores staged for the next start (2026-10)

A backup is a private directory of files described by a manifest written last, not one big
archive: app data written by the agent does not have to be copied twice, verification can name
the broken file, and a download is a plain tar generated on the fly (its size is known up front).
Database snapshots use SQLite's online backup API and leave out sessions. A full database
restore is staged and applied before the database is opened at the next start, because replacing
an open database under a running server would leave every in-memory service stale. Desktop
settings and app data are restored live. Database restores across installations with a different
server secret are refused, because encrypted secrets (including 2FA) could not be read.

App data is captured only while the app is stopped: copying a running database file by file is
not a consistent backup. The agent's stream protocol has no flow control, so archives are pulled
in 512 KiB chunks by the API and pushed back in chunks for a restore; the agent never reads or
writes files at paths chosen by the API. Archives are produced and validated by EveryOS's own
tar code (regular files, directories and symlinks only) instead of the system `tar`, so
validation and extraction rules are explicit and identical on every host.

## D23 — Tailscale is read and explained, never configured (2026-10)

EveryOS reads tailscaled's LocalAPI and compares Serve/Funnel handlers with its own configuration
(published URL, `publicOrigins`, trusted proxy) instead of offering buttons that change Tailscale.
Changing network exposure from the web UI would be an administrative action with a large blast
radius, and the CLI remains the single place where it happens. Public exposure through Funnel
raises a security notification.

## D24 — Private trash on source roots and account homes in every backup (2026-10)

Normal file deletion moves into private per-account storage on the source root, keeping data
recoverable without copying or deleting it across filesystems. Original paths are metadata; they
are validated again at restore time, and existing names are never silently overwritten. Internal
trash storage is unreachable through ordinary file routes. Permanent deletion is a distinct
authorized, confirmed and audited action. This is EveryOS's trash, independent of a host desktop.

Existing EveryOS home directories, including their private trash, join all backup triggers. Homes
are API-owned data, so the unprivileged API captures/restores them without adding an agent
operation. Archive contents are declared by account id in the manifest; restore matches only
existing ids and is separately selected. Safety backup, draining active file operations, private
validated staging and rollback protect a replacement. Host mounts and unsupported current data
are refused for replacement. Older version-1 manifests without homes remain readable.

## D25 — Linux power telemetry and private folder image assets (2026-10)

Power is read only by the agent, from Linux power_supply sysfs. Missing sensors stay unknown;
reported charger limits never become consumption estimates. Other platforms expose unavailable
instead of adding a second collector. The menu bar reflects the managed host, not the viewing
browser's battery.

Folder icon choices belong to the user's appearance document, including per-location overrides.
Owned raster uploads share the existing wallpaper table and snapshot storage, distinguished by
safe `folder-icon-` filenames. Purpose checks isolate both endpoint families. This keeps backup,
restore and account deletion complete without a new image store or database migration. Uploaded
references are validated against ownership, and used assets cannot be deleted.

See [power and folder icons](power-and-folder-icons.md) for formats, limits and behaviour.

## D26 — EveryOS naming with backwards-compatible stored data (2026-10)

EveryOS is the product name. Workspace packages use `@everyos/*`, environment variables use
`EVERYOS_*`, built-in app ids use `everyos.*`, and fresh Linux installations default to
`/etc/everyos`, `/var/lib/everyos`, `/usr/lib/everyos` and `/run/everyos`. Fresh databases are
`everyos.db`; downloads and new backup/theme manifests also use the new name.

The rename must not reinitialize an existing installation. API and agent configuration accept
`OTUKEN_*` aliases, with `EVERYOS_*` taking precedence. The default config paths fall back to
existing `/etc/otuken` files, the API reuses an existing legacy database, and no host directory,
account, service or container is renamed automatically. Existing app ids and the dusk wallpaper
id normalize on preference reads. Browser language/theme caches and session cookies can still be
read under their old names. Legacy theme and backup archives remain importable and restorable.

Version-1 cryptographic salts, derivation purposes, recovery-code hashes and agent handshake
domains retain their original bytes. Managed Compose project ids (`otk-*`), Compose placeholders
and inline-file extension names, private trash directories and home folder metadata keep their
persisted identifiers; changing these without a migration could lose access to owned data or
weaken protection. Both the old and new systemd service names are protected. The owner renamed
the public GitHub repository to `goktugcy/everyos`. Repository metadata, installation defaults and
security-report links use that name; release publication explicitly targets `GITHUB_REPOSITORY`.
The updater and bootstrap installer map only the old owner's GitHub Releases root to the new
root, preserving the configured public key and all custom sources. Configuration reads expose
the effective new source without silently rewriting root-owned files.

## D27 — Signed releases and independent database-aware recovery (2026-10)

EveryOS releases are separate from ordinary host APT updates. A root-owned Ed25519 trust anchor
verifies bounded metadata and exact architecture-specific Debian packages. The browser and CLI
use authenticated API operations; they cannot choose a privileged URL, key, script or command.
The first installer caches its verified package so the first self-update has a recovery artifact.

A dedicated root systemd worker survives API/agent restarts. A fresh verified archive preserves
all account homes; an additional offline SQLite snapshot captures the exact downtime boundary.
Durable transaction markers and package/schema/health checks recover the previous binary and
database together after installation failure, failed migration or interruption. Release migrations
are database-only until an external-data recovery contract exists. Root journal and fsynced audit
records survive database restoration. Purge keeps data, keys, backups and cached recovery packages;
deleting retained data is a separate owner action. See [packaging.md](packaging.md).

## D28 — Self-contained release bootstrap (2026-10)

The one-command installer is a generated GitHub release asset. The release signer embeds the
reviewed Python verifier and its derived Ed25519 public key into a Bash template, then signs the
exact resulting bytes with the existing publisher key. It does not fetch unsigned executable
code at runtime. HTTPS to the official release establishes trust for the pipe-to-Bash path;
independent key verification, script inspection and detached-signature verification remain a
manual alternative. A custom installation domain has not been configured.

Platform checks and an existing-database refusal precede prerequisite installation. Temporary
code and key files live under a root-private `/var/lib` directory because the verifier rejects
keys under writable ancestors such as `/tmp`; an exit trap removes only that generated directory.
The underlying Python installer persists the verified recovery package and root-owned trust
configuration. Existing installations continue through the authenticated update workflow.

## D29 — Personal OS identity and a bundled default wallpaper (2026-10)

The owner positions EveryOS as a personal OS experience on an existing Linux installation.
The README, product tagline and About descriptions lead with files, apps and a personal browser
workspace. The owner-provided logos, desktop screenshot and mountain artwork are stored locally;
the README selects a readable wordmark for each color scheme.

The mountain image gets a new built-in preset instead of replacing the existing Dusk preset.
The default Liquid Dark theme resolves to that preset; explicit user wallpaper choices continue
to take precedence. Built-in assets are public, while uploaded images keep their authenticated
ownership boundary. Photographic presets use worst-case black/white contrast bounds, are static,
and fall back to CSS if the packaged image cannot load. See [branding.md](branding.md).

## D30 — Automatic network access for fresh installations (2026-10)

At the owner's request, the verified installer from 0.1.2 enables an IPv4 wildcard binding only when
no API conffile exists before package installation.
Choosing one detected interface address would remove loopback connectivity required by the
verified installer, CLI and independent update worker, and would fail after address changes.
The wildcard binding accepts the host's current LAN and Tailscale addresses while keeping those
local control paths. The packaged conffile remains loopback-only: changing its default would also replace an
unchanged older conffile on upgrade, even with `--force-confold`. The initial installer writes
the wildcard binding atomically with the original owner/group/mode and restarts only EveryOS's API.
Generic API/development defaults remain loopback-only; upgrades preserve existing conffiles
and require an owner action to change their network exposure.

The installer enumerates actual active IPv4 interfaces with the packaged `iproute2` dependency
and advertises only addresses whose health endpoint responds. It does not infer a public WAN
address or modify firewalls, router mappings or Tailscale. Existing HTTP transport warnings,
authentication, permissions, CSRF checks and the unprivileged API remain in effect.

Browser UUID generation uses `crypto.randomUUID` when available, with a UUIDv4 fallback backed
by `crypto.getRandomValues`. The latter is available over ordinary HTTP; opening a host-IP URL
must not break initial widget preferences, file uploads or Pulse uploads.

## D31 — Per-user Linux identities and verified system authorization

Production binds each EveryOS UUID to an existing local Linux account after EveryOS
re-authentication and PAM proof. Root-owned records pin name and UID. Credentials are never
persisted or included in process arguments. EveryOS roles remain an independent restriction.

The root agent retains `ProtectHome=read-only`. PID 1 starts bounded account units outside that
mount namespace, so a normal login can write its home without weakening the agent's protection.
File/system workers receive fixed typed operations and no privilege keys. Host files always use
the account's unprivileged UID and supplementary groups, including while sudo is verified.

Root-only typed operations require sudo to execute a fixed root-owned authorization witness.
Password verification originally granted the authenticated EveryOS session five minutes of access;
D35 adds explicit durable durations. The password is discarded immediately. Actual sudoers
authorization is checked instead of inferring
rights from group names. Restricted sudoers rules for unrelated commands do not authorize EveryOS;
those commands remain available normally in the terminal. Existing unit/container protection
still applies. Existing personal storage stays API-owned, preserving desktop data and backup
access; Linux homes are additional host locations. Private host widget sources use the
subscriber's account. See [Linux account linking](linux-accounts.md) for details.

## D32 — Explicit all-entity Home Assistant scopes and a native panel

All-entity access is an explicit connection setting, separate from per-widget selection.
Missing scope fields retain existing selected allowlists, so upgrading never silently exposes
presence or other previously hidden entities. New UI connections visibly choose All by default;
changing an existing connection requires an administrator action. The audience remains managers
unless explicitly shared. PATCH schemas omit creation defaults to preserve untouched settings.

The native panel and widgets share the sanitized states topic. Fixed service contracts cover
common device domains without exposing an arbitrary Home Assistant service endpoint. Fresh
state/capability checks, numeric bounds and option membership are enforced on the server.
Unlocking requires an explicit confirmation. Read-only entities remain useful in the same panel.
Direct refresh reads recheck audience and settings after collection to avoid returning a result
from a revoked scope. EveryOS never fabricates a state after accepting a command.

### D33 — Device registry recognition with optional logos

Home Assistant device metadata comes from three fixed WebSocket registry reads rather than
inferring brands/models from entity names or integration platforms. Sanitize and cache it on
the API, then join it only to scoped states. The default panel groups physical devices and puts
secondary controls in details; an entity view keeps virtual items accessible. Registry failures
leave state/control functionality intact and are visible in the UI. Brand logos use a fixed,
bounded same-origin PNG proxy to Home Assistant Brands, with local device symbols as fallbacks;
the CSP and credential isolation stay unchanged.

### D34 — Signed EveryOS release notifications

Poll the existing agent release manager rather than introducing a second version feed. The API
monitor performs system-actor status/check reads in production, with hourly remote checks and
15-minute error backoff. A durable notification condition keyed by candidate version preserves
per-user read/dismiss state across checks and restarts. Manual About requests observe that same
condition. Allowing system actors for the two non-installing operations enables unattended
notification discovery; installation remains an explicit user action under existing controls.

### D35 — Explicit durable Linux privilege durations

The owner needs one-time Linux privilege verification with selectable finite or indefinite
lifetimes. Explicit duration requests create an account-wide grant; legacy requests without a
duration retain five-minute session grants. Logout and desktop lock revoke only session grants.
Manual privilege lock revokes both scopes. Increasing or changing duration requires PAM and
actual sudo witness authentication again; no password is persisted or replayed.

Store grants in a root-owned private atomic sidecar, pinning the EveryOS UUID and Linux name/UID.
Keep the existing binding-file shape compatible with older agents. Bind the sidecar to the
binding file's content and filesystem stamp so an older agent's unlink/relink cannot reactivate
an indefinite grant. Unrelated users' binding changes preserve their grants. Link changes,
account replacement and EveryOS disable/delete revoke the affected user's grant.

Every privileged call rechecks PAM account policy and root's fixed sudoers command-list query.
Policy denial removes the grant and fails closed. Current EveryOS roles and protected-resource
checks remain independent. One month is exactly 30 days; finite expiry uses wall-clock timestamps
across restarts. No option elevates file-manager workers above the mapped Linux identity.

### D36 — Automatic application defaults and durable available-port allocation

Provide PUID/PGID from the linked Linux account and TZ from the agent, not from browser input
or process-environment interpolation. A fixed read-only `apps.defaults` operation is permissioned
and validated. Hide these canonical inputs in the installer and move optional parameters/ports
under Advanced settings. Genuine required external configuration remains explicit; app-native
setup happens after launch. Existing deployments are not silently reconfigured.

Let Docker allocate omitted published ports atomically. Then verify the exact owned project's
bindings, recreate that deployment with fixed ports, and seal the resulting Compose. Merely saving
the allocation is insufficient: Docker reassigns an ephemeral HostConfig binding on restart.
The final pinning deployment is part of installation success and failure cleanup. Retry/update
reuse saved allocations. Keep explicit host-IP and protocol restrictions. An explicit manual port
remains an explicit port, including normal failure when another host service owns it.

Share measured icon-caption fitting across desktop, Files and the mobile launcher. Keep a readable
9px floor; exceptionally long names expand on interaction rather than becoming unreadable. Text
selection plates are removed while glyph highlighting and keyboard focus remain visible.

### D37 — EveryOS updates without redundant password confirmation

Use the authenticated, unlocked administrator session to authorize explicit EveryOS version
installation. Remove the additional EveryOS password field and reauthentication from the web
panel, CLI installation payload and API. Keep current server permissions, CSRF, user-only agent
policy, actual Linux privilege checks, signed release validation and verified fresh local safety
backups. This does not grant unattended installation or alter Linux sudo verification lifetimes.

Accept an optional bounded legacy password field without using it, so a cached older client can
complete an upgrade. New clients do not send it. Authentication, session unlocking and backup
restoration retain their existing password requirements.

### D38 — Live application folder and dismissible operation notices

Expose Store-managed installations as a built-in folder backed by the existing permissioned
`/apps` list. Do not relocate host packages or Docker data, create executable shortcut files or
invent endpoints. Use real published web ports with loopback restrictions; unavailable/stopped
and simulated applications open management details. Reuse existing catalog image proxies,
caption fitting, selection geometry and lifecycle controls.

An optional desktop-preference marker adds the shortcut once for existing accounts while
preserving custom layouts and explicit later removal. App entries remain derived from real
installations rather than persisted per-user copies, so removal cannot leave stale launchers.

Dismiss notices by their job identity, keeping progress watchers mounted. Completion must
refresh installation state even when SSE is unavailable. Hide only presentation, preserve job
history/audits and show the next operation's notice independently.

### D39 — Applications in Files without a fabricated filesystem directory

Keep the same live managed-application collection under the localized Applications name across
the desktop, launcher, Files Favorites and the home view. Embed the existing application panel
in Files rather than creating executable shortcuts or relocating Docker data. Persist the
window's place independently from its ordinary root/path; navigation returns to real files.

The home entry is a separate native UI item, not a FileEntry or filesystem path. Exclude it
from rename, clipboard, trash and drop handlers, and preserve an owner's physical folder with
the same name. The existing apps permissions and server lifecycle checks remain authoritative.
Retain the production hourly signed-release monitor and verify its timer-driven notification
behavior. About displays that cadence and the actual last remote check.

### D40 — Managed application shortcuts and shared lifecycle confirmation

Persist installed-application shortcuts in the existing app-ID preference fields as
`everyos.installed.app-<installation UUID>`. Resolve only those IDs against the permissioned
live installation list; store no launch URL, port, executable or catalog code in preferences.
Built-in launcher defaults stay unchanged. Clear installation metadata between sessions and
only prune missing installations after a successful listing, preserving shortcuts when offline.

Resolve current ports again on activation. Reserve a browser tab during the user gesture for
a known running host web app, detach its opener, then navigate after the fresh listing. Close
the tab if the session changes, locks or loses permission. Other states open Applications details
without automatically starting containers. Both the folder context menu and management cards
share lifecycle confirmation and the existing server jobs. Shortcut capacity and duplicate checks
apply before persistence, and removal of the application cleans up its derived shortcuts.

### D41 — Capability-driven Home Assistant controls and room isolation

Expose a fixed, typed service/field manifest rather than generating executable actions from
remote Home Assistant service descriptions. Registered services, entity feature flags, color
modes, numeric bounds and choices jointly determine sanitized controls. Re-read those inputs
before every command and validate the requested setting against the fresh descriptor; existing
scope, permission, audience, session and audit checks remain authoritative. Keep setting payloads
out of audits. Unsupported custom integrations open the original authenticated Home Assistant
interface without transmitting its stored token to the browser.

Editors keep unsent drafts separate from reported device state and require Apply. Split a physical
device's allowed entities by effective area before making cards; an entity's area override must
not bring another room's siblings into its details. Paginate room-sorted cards and preserve filters.

### D42 — Live release state and recovery of missed version notifications

Publish verified release snapshots on a fixed `release` event topic requiring `system:read`,
using the existing session-checked multiplexed stream. Reuse the monitor and signed release cache;
never infer an available release from unverified notification text. Retain read-only polling and
cancel older reads when a live or manual result arrives.

Own notification subscriptions at the authenticated shell rather than the optional bell module.
Recover unread, unresolved version notices on reconnect/visibility/network restoration and with
a bounded polling fallback. Deduplicate seen version IDs per session and preserve toast/mute
preferences and server read/dismiss state. Keep late events/requests from previous connections
or sessions out of the active state. Do not change remote-check frequency or install automatically.

### D43 — Per-account agent runtimes and native chat

Use fixed repository-owned, digest-pinned official Hermes/OpenClaw templates through the existing
managed-application service and agent policy. Do not add shell/install-script operations. Keep
new runtimes per account, loopback-only, with persistent owned app data and no host mounts/socket.
Generated deployment keys are encrypted; Compose's literal-secret classification is acknowledged
only for these trusted templates. Inline configs are read-only and materialized in verified tmpfs;
they do not invalidate backup eligibility of otherwise exclusively owned app-data mounts.

Require application management plus terminal access even with tools disabled, since the upstream
runtime can perform agent actions. Offer explicit external connections without adopting or
modifying them. Keep each owner's sealed chat history separate, forward only bounded fixed chat
requests, and re-check session permissions during streams. Persist only completed turns; abort
on lock/disconnect and never retry automatically. Do not claim that stopping undoes tools or that
deleting local history clears upstream memory. Label development simulator state as unverified.

Use Linux AMD64/ARM64 runtime smoke checks with real official containers and a disposable fake
provider to verify template compatibility and tool disabling without paid calls or personal data.

Existing native agents are detected/imported with two fixed read-only operations executed as the
bound Linux account, even when sudo is active. Only known layouts/executable locations are probed;
no root file reads, arbitrary paths, commands, executable config imports or service changes.
Review import choices against a settings fingerprint. Seal copied credentials/history, cap imports,
preserve source-ID deduplication, and never overwrite EveryOS conversations already continued.
Read current SQLite active transcripts (bounded zstd) and legacy text JSONL without migrations.
Scrub known credentials across streamed delta boundaries and imported messages.

### D44 — Five-minute signed release checks

Supersedes the hourly cadence in D34, D39 and D42. An hour-long discovery delay left published
releases unannounced for up to an hour, and the per-check cost is one small signed `release.json`
download. The monitor now checks remotely every five minutes with the same one-minute cache tick,
15-minute failure backoff, signature verification and shared manual-check timestamp. A pushed
notification would need a relay service outside the host; EveryOS does not add one. Discovery
still never installs an update.

### D45 — Agent-reported chat failures and Open WebUI task filtering

Show the reason an agent itself reports for a failed run (its stream `error.message`), redacted for
the configured keys, stripped of control characters and capped at 300 characters, instead of a
generic system error. The reason only goes to the owner of that agent connection. Raw HTTP error
bodies stay hidden. A `finish_reason: "error"` stream is a failure even after fallback text.

Open WebUI sends background title/tag/follow-up generations through the same chat API as
single-turn "### Task:" prompts; on a real host they outnumbered chats seven to one. Import skips
them and Hermes's text-less tool-call steps, scanning up to 200 sessions. Import removes earlier
copies of tasks that have only their imported prompt and answer. It refreshes imported copies still
at the source timestamp, since continuing a chat in EveryOS moves that timestamp.

### D46 — Local models and a private network for EveryOS AI apps

Add `local` as a third chat target: a direct, tool-free chat with an OpenAI-compatible server,
sending a key only when one is set. Discovery stays read-only and loopback-only: default ports of
common servers, ports of matching processes from the agent's socket list, and official server
images among containers. Model management only addresses discovered Ollama servers by id.

Install at most one system-wide EveryOS Ollama as a repository-owned built-in app: models are large
and shared, chats stay per account. GPU acceleration is offered only for hardware Docker reports
and reuses the application `devices` risk with administrator approval; built-in reconfiguration may
accept exactly that risk. Raise image pull and job deadlines for multi-gigabyte model servers.

A container cannot reach another project's port published on 127.0.0.1, and catalog networks stay
blocked. Let only EveryOS's own AI templates request an agent-created internal network with an
ownership label, injected after validation. Servers listening beyond loopback remain reachable from
managed agents through `host.docker.internal`. Downloads and deletions on an Ollama EveryOS did not
install need an extra confirmation, since other applications may depend on its models.

Settings become an overview of assistants plus a four-step setup wizard; details are split into
Connection, Model and Advanced. Plain-language copy replaces gateway/API-model jargon.

### D47 — Plain-language behavior settings for local models

Small local models answered without any system message and with server-default sampling, which
made them drift between languages and invent facts. Send every local chat a system message
(template or user instructions, a length hint and an explicit language rule) and sampling settings
expressed as human choices: creativity, answer length, conversation memory and repetition. Store
them with the sealed local settings; saves that omit them keep the stored ones, and agents never
store them. Use Ollama's own chat API for Ollama servers so memory and repetition apply, and
OpenAI-compatible parameters elsewhere. Offer a non-persisting **Try it** on the saved model, and
warn below 4B parameters instead of pretending settings can fix a model that is too small.

### D48 — Switching chat models per assistant, and a chat widget

The owner wants to see and switch the model behind every chat. Each runtime offers a different
dependable route, so EveryOS uses the one each documents instead of one lowest-common mechanism:
local models change the account's saved model; Hermes (managed or found on the host) lists its
authenticated providers through `GET /api/model/options` and runs a turn on another model when
the request names `model` and `provider`, leaving its `config.yaml` untouched; OpenClaw's
`x-openclaw-model` header is limited to models already in its catalog, so an OpenClaw EveryOS
manages is reconfigured and restarted after a confirmation, and one it does not manage is left
alone. Only a model the agent just listed is accepted. Answers record the model asked for, so a
switch inside a conversation stays visible. Favorites and the archive are per-conversation columns
and exclusive. The `ai.chat` widget calls the permission-checked assistant routes directly, so the
widget manifest allows an empty `dataSources` list for interactive widgets.

### D49 — Home-server essentials: power, disks, external channels, app settings

The production review found five gaps for a home server, implemented in one release.

**Power.** Restart and shutdown are typed operations (`power.control`), never a generic command:
the agent asks PID 1 for a transient timer that runs `systemctl reboot|poweroff` 5 s later, so the
API can answer and audit first. The account password, the action name and the blocker list guard
it; an EveryOS update in progress cannot be overridden. Restart-required uses the distribution
marker and the kernels in `/boot`, because the hardened units cannot see `/lib/modules`.

**Disks.** Mount only volumes on disks without any system mount, only known filesystems, only
under `/srv/everyos/disks/<uuid>`, never format or repair. Mounting through systemd mount units
(in `/run` or `/etc`) makes mounts host-wide and lets systemd own boot-time mounting with
`nofail`; `nodev,nosuid,noexec` always apply. Files reaches disks as the person's Linux account
(the account worker reads its own mount table), so Linux permissions keep applying; filesystems
without Unix permissions belong to the mounting administrator's Linux account, as a desktop
automounter would do. The API never gets write access to the disks.

**External channels.** ntfy, Telegram, e-mail (SMTP through nodemailer) and webhooks (Discord,
Slack, generic JSON) are notification providers. Anything that works like a credential (tokens,
topics, webhook URLs) is sealed and never returned. Texts are rendered on the server in the
channel's language; personal notifications never leave the app; a burst limit caps each channel.

**App settings and updates.** Keep the inputs, definition and fingerprint of each installation
so its settings can be changed and a newer catalog definition can be offered with the kept values.
Detection compares catalog definitions only (no registry polling, as the owner chose); older
installations are adopted only when their inputs reproduce the stored Compose file exactly.

**Mobile.** The notification center and the power actions are available in the mobile shell.

### D50 — Plugged-in disks, Google Drive and live transfers

**Disks come and go live.** The agent watches `/dev/disk/by-uuid` (inotify, a stream operation)
instead of the API polling `lsblk`; the API re-lists on each debounced tick and pushes listings on
a `disks` event topic. A new disk is announced and drawn on the desktop, but it is mounted only by
an administrator's click: mounting as root without anyone's decision would give FAT files no
owner. "Remembered" disks reuse the boot unit with an extra `WantedBy=` on the filesystem's device
unit, so systemd itself mounts them whenever they are plugged in and releases them when they go;
EveryOS runs no hot-plug handler of its own.

**Google Drive with the owner's own client.** Full Drive access for the public needs Google's
verification and a security assessment, so every server registers its own Desktop-app OAuth
client. Consent uses PKCE and a loopback redirect: automatic when the browser runs on the server,
a pasted address elsewhere (Google retired the copy-a-code flow). Each person connects their own
Drive; refresh tokens are sealed per person and only EveryOS's API talks to Google.

**One transfer model for every view.** Server copies are jobs with bytes, totals, a smoothed speed
and time left, streamed per person on a `transfers` topic; browser uploads report into the same
client store. The menu bar, dock shelf, pulse, Files and the phone header are views of that store,
so they never disagree. The pulse moves into the free middle of the menu bar instead of covering
modules, and a storage item with nothing to show takes no room.

### D51 — Complete locales with on-demand browser resources

Turkish remains the typed source; English is the product default and fallback. English, German,
Spanish, French, Italian, Japanese, Korean, Russian and Simplified Chinese implement the complete
source tree. Locale identifiers come from `SUPPORTED_LOCALES`, including API validation, agent file
operations and external notification channels. Regional catalog keys and Intl tags are explicit
mappings.

The server imports all resources through `@everyos/i18n`; browser runtime imports use
`@everyos/i18n/client`. Only English is bundled eagerly. Each other locale is a separate dynamic
import, and initial rendering waits for the stored language, or the browser's language when nothing
is stored. Concurrent requests for the same resource share one download. A later choice supersedes
earlier requests, and a failed download keeps the current language and stored preference so choosing
it again can retry.

Translation types require every source key and permit extra CLDR plural categories. Tests check
required plural forms, interpolation names, nonempty strings, language names and browser loaders.
Home folder names are selected at creation; a later locale change preserves existing names.
See [Internationalization](i18n.md) for editing and verification.

### D52 — Files dropped on the shelf are temporary

Files dropped on the pulse shelf from a computer used to land in Downloads and stayed there when
they left the shelf. They now wait in a hidden `.everyos-shelf` folder of the EveryOS home, which
the API serves directly in production too, so no agent operation is involved. Moving one into a
folder keeps it; removing it from the shelf, clearing the shelf or dragging it out of the browser
deletes it for good instead of putting it in the trash. A drag out deletes on the server after the
download completed (`discard=true`), because the page cannot know when the browser fetched it; the
session cookie is SameSite=Strict, so other sites cannot trigger that GET. Files the stored shelf
has not listed for an hour are tidied away, and the folder is left out of search and home backups.
Files referenced from Files windows are never deleted by the shelf. The old upload destination
stays in the `pulse` schema, unused, so stored preferences remain valid.

### D53 — Desktop apps run in an opaque-origin sandbox, authorized per call by the server

Third-party and official desktop apps are static bundles that run in `<iframe sandbox>` frames
without `allow-same-origin`, loaded from per-version capability URLs (`/app-runtime/<key>/…`) with a
`sandbox` CSP and no remote code. The owner reaches EveryOS by IP over plain HTTP, where neither a
second port (cookies are not port-isolated) nor a subdomain gives a separate site, so the opaque
origin is the isolation boundary. Apps talk to the desktop over a versioned `MessageChannel`
protocol; the desktop forwards privileged calls with a per-instance token and the server authorizes
every call against the installation's granted capabilities and the user's role. Packages are signed
`.eosapp` archives verified on the server against registry-signed publisher keys; `dev.everyos.*`
belongs to the pinned official registry. Official apps live in this repository; the community
registry is a Cloudflare service. The feature ships in one release (see
[App SDK architecture](app-sdk/architecture.md) and [acceptance](sdk-release-acceptance.md)).

### D54 — The official SSH app exports private keys only as protected OpenSSH files

The SSH Keys app requires a matching export passphrase before the desktop asks the person to
approve the key's fingerprint. This keeps an explicit private-export feature without a plaintext
export option in the official interface. The SDK retains its documented optional unencrypted
export for other authorized window apps; every private export still requires desktop confirmation.

The app has no app-storage or file-picking permission. Drafts and passphrases remain in memory,
and passphrase inputs clear before export and on cancellation, suspend or permission changes.
Names and comments are stored in the existing user vault, where private keys are encrypted by
`SecretBox`. Public-only deletion has an app-requested EveryOS confirmation; private-key deletion
uses the desktop's mandatory fingerprint confirmation. The app does not read host private keys.

OpenSSH's askpass reader accepts at most 1,023 bytes and terminates on line breaks, so protected
export validates the full UTF-8 passphrase length and rejects NUL, CR and LF. Generation is async,
and one crypto slot per API service bounds generation and protected exports while metadata reads
remain available. See [SSH key SDK contract](app-sdk/ssh-keys.md).
