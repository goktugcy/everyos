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
