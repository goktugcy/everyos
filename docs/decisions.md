# Architecture decision log

Short records of decisions that are not obvious from the code. Newest last.

## D1 — Node.js 26 as the runtime (2026-10)

**Decision:** Target Node.js 26. It becomes LTS on 2026-10-28 and is supported until 2029-04-30.
The `.deb` package will ship its own Node runtime under `/usr/lib/otuken/node`.
**Why:** Distribution Node packages are too old and vary across Ubuntu/Debian releases. Node 26
gives us `node:sqlite` as a release candidate, built-in TypeScript type stripping, and long
support. Node 24 leaves active LTS on 2026-10-20.
**Consequence:** contributors need Node 26 (`.node-version`).

## D2 — `node:sqlite` instead of better-sqlite3

**Decision:** Use the built-in `node:sqlite` (stability 1.2, release candidate since v25.7), wrapped
by `@otuken/database`.
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

**Decision:** The root entry of `@otuken/shared` contains only types and constants. Zod schemas
live in `@otuken/shared/schemas`.
**Why:** The schemas are top-level side-effectful calls that bundlers cannot tree-shake. Importing
them pulled about 90 KB (minified) of zod into the web client. The initial web chunk is now
329 KB raw / 105 KB gzip.

## D9 — First-run setup token

**Decision:** Creating the first account requires a token from
`/var/lib/otuken/setup-token` (0600).
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
missing, or with `OTUKEN_AGENT_SIMULATE=1`). Every simulated response carries
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
writes files at paths chosen by the API. Archives are produced and validated by Otuken's own
tar code (regular files, directories and symlinks only) instead of the system `tar`, so
validation and extraction rules are explicit and identical on every host.

## D23 — Tailscale is read and explained, never configured (2026-10)

Otuken reads tailscaled's LocalAPI and compares Serve/Funnel handlers with its own configuration
(published URL, `publicOrigins`, trusted proxy) instead of offering buttons that change Tailscale.
Changing network exposure from the web UI would be an administrative action with a large blast
radius, and the CLI remains the single place where it happens. Public exposure through Funnel
raises a security notification.
