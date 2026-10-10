# Roadmap and milestones

Each phase ends with a working, tested increment. "Done" means the feature works with real data,
permissions are enforced on the server, tests pass, and the documentation is updated. A screen
that looks finished is not enough.

| Phase | Scope                   | Status        |
| ----- | ----------------------- | ------------- |
| 1     | Foundation              | **Completed** |
| 2     | Desktop shell           | **Completed** |
| 3     | Linux integration       | Planned       |
| 4     | Docker management       | Planned       |
| 5     | Multi-catalog App Store | Planned       |
| 6     | Widget platform         | Planned       |
| 7     | Advanced tools          | Planned       |
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

## Phase 3 — Linux integration

Metric collectors (CPU, memory, disk, network, load, temperature, Raspberry Pi throttling) in the
agent, a shared SSE topic stream, bounded in-memory history, systemd unit management with a
protected-unit policy, journald log streaming with filters, Tailscale status through LocalAPI,
the first system widgets, and **real measurements on the Raspberry Pi 5**.

## Phase 4 — Docker management

Docker Engine API through the agent, discovery of containers and Compose projects (marked as
Otuken-managed, imported or external), lifecycle operations with ownership-aware restrictions,
live logs, stats, and image, volume and network views. Nothing is ever removed automatically.

## Phase 5 — Multi-catalog App Store

Adapters, in order: CasaOS v2, CasaOS source, Big Bear, Runtipi, Coolify, Portainer, plain compose
(see [research/catalog-formats.md](research/catalog-formats.md)). The phase also covers catalog
settings, SSRF-safe synchronization with snapshots, duplicate detection, the install policy engine
(risk flags), transactional install with rollback and streamed progress, and lifecycle operations.

## Phase 6 — Widget platform

Widget registry and manifest validation, topic-based data providers, layouts on desktop, sidebar
and menu bar, the configuration UI, app-specific adapters (Jellyfin, Immich, Home Assistant,
Uptime Kuma, Nextcloud, PostgreSQL), and widget offers after app installation.

## Phase 7 — Advanced tools

File manager (allowed roots, streaming transfers), terminal (xterm.js, PTY via the agent with a
dedicated permission, idle timeout), update manager, backup and restore, scheduler, notification
center with providers, and advanced Tailscale integration.

## Phase 8 — Packaging and hardening

Debian packages for arm64 and amd64 with a bundled Node runtime, systemd units with sandboxing, an
`otuken` CLI (`status`, `doctor`, `version`, `backup`, `restore`, `update`), a verified installer,
install/upgrade/purge tests in disposable VMs, release automation, and a security review.
