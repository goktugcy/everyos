# Roadmap and milestones

Each phase ends with a working, tested increment. "Done" means the feature works with real data,
permissions are enforced on the server, tests pass, and the documentation is updated. A screen
that looks finished is not enough.

| Phase | Scope                   | Status        |
| ----- | ----------------------- | ------------- |
| 1     | Foundation              | **Completed** |
| 2     | Desktop shell           | **Completed** |
| 3     | Linux integration       | Implemented   |
| 4     | Docker management       | Implemented   |
| 5     | Multi-catalog App Store | Implemented   |
| 6     | Widget platform         | Implemented   |
| 7     | Advanced tools          | Implemented   |
| 8     | Packaging and hardening | Planned       |

## Phase 1 — Foundation ✅

- pnpm monorepo, strict TypeScript 6, ESLint, Prettier, Vitest, Playwright, CI for amd64 and arm64.
- Hono API: health and bootstrap endpoints, first-run setup with a token, login, TOTP and recovery
  codes, sessions, CSRF protection, rate limiting, roles and permissions, user administration, and
  an audit log.
- SQLite via `node:sqlite` with versioned migrations, pre-migration backups and downgrade protection.
- Privileged agent with an authenticated Unix-socket protocol and a typed operation registry
  (`agent.ping`, `system.info`).
- Real host introspection with capability detection.
- React web client in Turkish (default) and English, with Liquid Glass styling, setup wizard,
  login, an account security dialog and the system overview.
- Production build: two bundled server files plus the pre-compressed web client.

**Measured on a MacBook Air (M2), Node 26.10:** API ≈72 MiB RSS idle (+64 MiB transient per
password hash), agent ≈62 MiB RSS idle, 0.09 s agent CPU in 45 s. The API and agent connect
within 131 ms of start. Raspberry Pi 5 measurements are still to be done (Phase 3).

## Phase 2 — Desktop shell

Milestones:

1. Extend the glass component set in `apps/web/src/components/ui` and desktop menus (context
   menus, tooltips, switches, sliders, selects). Extracting `packages/ui` is deferred until a second
   consumer exists; see [D11](decisions.md#d11--desktop-ownership-and-client-persistence-2026-10).
2. Theme engine: the 7 presets (Liquid Dark, Frost Blue, Graphite Glass, Aurora, Minimal Clear,
   Neon Night, Liquid Light), per-user overrides, render presets (Performance, Balanced, Premium),
   import/export, and contrast checks in tests.
3. `packages/window-manager`: the controller from [contracts.md §2](contracts.md#2-window-manager-api-phase-2),
   snapping and tiling, keyboard shortcuts, viewport clamping, and layout persistence via
   `user_preferences`.
4. Desktop: icons and folders with drag and drop, virtual desktops, a context-menu framework, an
   application launcher with global search, a dock/taskbar (floating, taskbar or hybrid; bottom,
   left or right), and a top menu bar with configurable modules.
5. Mobile launcher for narrow viewports.
6. Built-in apps registered through the app contract: Settings (Appearance, Account, Users, Audit
   log), and System (the current overview).

Acceptance: Playwright tests for window drag, resize and snap, context menus, dock actions, theme
switching and layout persistence across reloads. The desktop stays responsive (no long tasks over
50 ms) with 10 open windows.

Implemented: the theme and window-manager packages, user-owned preference/wallpaper APIs,
desktop/mobile shells, launcher/search, dock, icon folders, virtual desktops, built-in apps and
API-enforced session locking. Browser acceptance covers the real System/Users/Audit apps,
cross-user isolation and all desktop interactions listed above. The ten-folder-window drag test
recorded no main-thread tasks over 50 ms in Chromium on the development MacBook Air M2; this is a
local measurement, not a Raspberry Pi or cross-browser performance guarantee. Host metrics/widgets,
Docker controls and host file management remain in their respective later phases. Shared UI
package extraction remains explicitly deferred as described in D11.

## Phase 3 — Linux integration (implemented; verified on a Raspberry Pi 5 without root)

Implemented: metric collectors (CPU, per-core, memory, swap, load, network, disk I/O, thermal
zones, drive temperatures, CPU frequency, fans), storage usage, Raspberry Pi throttling, NVMe SMART
health, network interfaces/gateways/DNS/internet reachability, Tailscale status through LocalAPI,
process list; agent stream operations with backpressure; `MetricsHub` with bounded in-memory
history; a shared SSE topic stream; systemd unit listing/detail/actions with a protected-unit
policy and audit; journald queries with cursor paging and live streaming; System Monitor, Services
and Logs apps; resources and network menu bar modules; development simulator.

Verified on 2026-10-10 on a Raspberry Pi 5 Model B Rev 1.1 (8 GB, NVMe, Ubuntu 26.04.1, kernel
7.0.0-1020-raspi, systemd 259, Tailscale 1.104, Docker host), as an unprivileged user in a
temporary directory with the system Node.js 22.23 (no packages installed):

- Every collector result validated against its schema; systemd JSON output, `systemctl show`
  format, journald cursor paging (no overlap, correct order), unit/priority/grep/since filters and
  `journalctl --follow` behave as the fixtures assume. Tailscale LocalAPI is readable without root.
- Found and fixed: the firmware `get_throttled` sysfs node does not exist on this kernel and
  `/dev/vcio` is root-only (reported as `permission-denied`, available to the root agent);
  container links (`k-p-e-*`, `br_kasm_sidecar`) were counted as Ethernet and in host traffic
  (now classified by their `device` link; only physical NICs count); NVMe temperature is read from
  hwmon without smartctl; protected units now accept only `start` (Ubuntu's `ssh.service` is
  socket-activated); `/proc` reads used 64 KiB buffers per file, inflating agent RSS by ~70 MiB
  per process listing (now bounded 4 KiB chunks with limited concurrency); journald output fields
  are restricted (−44% output).
- Measured (development mode, Node.js 22): agent RSS ≈ 92 MiB idle and ≈ 113 MiB after repeated
  heavy requests; API RSS ≈ 86 MiB (162 MiB peak during first-run setup, from scrypt's 64 MiB
  memory cost); CPU ≈ 0.3–0.5% of one core for each process with or without a live subscriber.
  Typical latencies: metrics 30–40 ms, services list ≈ 1 s (two `systemctl` calls on 330 units),
  processes ≈ 0.6 s (500 ms CPU sampling window), logs ≈ 20 ms.

Not yet verified (needs root or production packaging, Phase 8): the agent running as root with
`/run/otuken` and the socket group, `vcgencmd`/`smartctl` output as root, real service actions,
Node.js 26 on the Pi, and the `tailscale serve` header recipe. System widgets were delivered with
the Phase 6 widget platform.

## Phase 4 — Docker management

Docker Engine API through the agent, discovery of containers and Compose projects (marked as
Otuken-managed, imported or external), lifecycle operations with ownership-aware restrictions,
live logs, stats, and image, volume and network views. Nothing is ever removed automatically.

Implemented and verified with real read-only Docker on the Raspberry Pi 5: Engine/Compose
discovery, ownership-aware imports/actions, protected-container/project policy, logs and live
stats, resource inventories and explicit unused-resource deletion. Browser tests use the labeled
simulator for lifecycle/deletion and cover desktop/mobile permissions and error recovery.
See [docker-management.md](docker-management.md) for measurements and limits. Real mutations and
root-agent deployment still need dedicated disposable-host acceptance; existing owner resources
were not modified. Managed ownership and App Store installs remain Phase 5.

## Phase 5 — Multi-catalog App Store (implemented and verified)

Adapters, in order: CasaOS v2, CasaOS source, Big Bear, Runtipi, Coolify, Portainer, plain compose
(see [research/catalog-formats.md](research/catalog-formats.md)). The phase also covers catalog
settings, SSRF-safe synchronization with snapshots, duplicate detection, the install policy engine
(risk flags), transactional install with rollback and streamed progress, and lifecycle operations.

Implemented: bounded catalog readers, safe atomic/incremental synchronization, architecture
variants, duplicates, catalog management/browsing, metadata/screenshots/forms, Compose policy,
encrypted configuration, immutable images, health-aware image rollback, durable jobs/reconciliation/
retry, lifecycle controls, launch links, managed ownership and stopped owned-instance data transfer.

Verified with live catalog reads, API/unit tests, browser acceptance and 13 real Docker scenarios
in a dedicated ARM64 Linux VM with a root agent and unprivileged API. See
[app-store.md](app-store.md) and [the acceptance record](phase5-acceptance.json).
Standalone Linux Compose is the contract: Swarm/Windows/build/hooks/external-file features remain
explicit unsupported outcomes. Existing proxies/DNS/TLS remain owner-managed; image rollback does
not promise database downgrade or application-aware restore (Phase 7). Production packaging and
host-specific hardening remain Phase 8.

## Phase 6 — Widget platform (implemented and verified)

Widget registry and manifest validation, topic-based data providers, layouts on desktop, sidebar
and menu bar, the configuration UI, app-specific adapters (Jellyfin, Immich, Home Assistant,
Uptime Kuma, Nextcloud, PostgreSQL), and widget offers after app installation.

Implemented:

- **Registry:** 44 built-in widgets (system, Raspberry Pi, Docker, apps) with versioned manifests,
  compatibility checks, generated configuration and migration.
- **Data:** the shared `DataHub` topics (12 system topics plus integration feeds) on the existing
  SSE stream, plus new read-only agent collectors for listening sockets, APT updates and systemd
  timers.
- **Integrations:** sealed credentials, an audience setting, an SSRF-safe client, Home Assistant
  quick controls, and fixed-query PostgreSQL statistics.
- **Desktop:** a grid layer (drag, resize, keyboard move), the sidebar, menu bar widgets, the
  gallery, configuration dialogs, Settings › Widgets with connection management, and post-install
  offers in the Store.

Verified with unit/API tests, browser tests (including a Jellyfin fixture server) and a read-only
run on the Raspberry Pi 5. See [widgets.md](widgets.md). Not yet verified:

- the app adapters against the owner's real apps (credentials needed);
- process names for sockets and Raspberry Pi throttling flags, which need the root agent
  (Phase 8);
- widgets on the mobile launcher.

## Phase 7 — Advanced tools (implemented)

File manager (allowed roots, streaming transfers), terminal (PTY via the agent with a dedicated
permission, idle timeout), update manager, backup and restore, scheduler, notification center with
providers, and advanced Tailscale integration.

Implemented:

- **Notification center:** conditions and events with per-user state, the host monitor, live
  delivery, a menu bar bell with toasts, settings and providers ([notifications.md](notifications.md)).
- **File manager and text editor** over configured roots and private homes, with desktop
  multi-selection, marquee selection and recoverable per-user trash ([files.md](files.md)).
- **Terminal (7.3):** agent PTY relay, API WebSocket gateway and the lazy browser client, with
  permission checks, idle timeout, limits, audit, theme support, resize, reconnect/reload replay
  and confirmed cleanup of detached sessions ([terminal.md](terminal.md)).
- **Update manager** with package details, background jobs and history ([updates.md](updates.md)).
- **Scheduler** with predefined actions, cron schedules, catch-up, cancellation and history
  ([tasks.md](tasks.md)).
- **Backup and restore:** verified backups of the database, configuration, wallpapers, personal homes and app
  data (with the app stopped), retention, download/upload, restore preview, safety backups,
  live desktop restore and staged database restore ([backups.md](backups.md)).
- **Tailscale:** node details, Serve/Funnel remote-access analysis, warnings and notifications,
  and the device list for administrators ([tailscale.md](tailscale.md)).

Verified with unit/API tests and browser tests (a stand-in tailscaled LocalAPI for Tailscale,
the labelled apt simulator for updates). Not yet verified: apt upgrades and app-data backups with a
root agent on real hardware, and the restart after a staged database restore under systemd
(Phase 8 units).

## Phase 8 — Packaging and hardening

Debian packages for arm64 and amd64 with a bundled Node runtime, systemd units with sandboxing, an
`otuken` CLI (`status`, `doctor`, `version`, `backup`, `restore`, `update`), a verified installer,
install/upgrade/purge tests in disposable VMs, release automation, and a security review.
