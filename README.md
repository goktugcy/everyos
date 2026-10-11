<p align="center">
  <img src="apps/web/public/everyos.png" width="72" height="72" alt="EveryOS logo" />
</p>

<h1 align="center">EveryOS</h1>

<p align="center"><em>A modern, customizable desktop experience for your self-hosted infrastructure.</em></p>

EveryOS is an open-source, self-hosted Linux server management platform with a web desktop
interface inspired by "Liquid Glass" design. You install it on an existing Debian- or Ubuntu-based
server (it is not a Linux distribution) and use it alongside your existing services and containers,
without taking them over.

> **Status: initial public release (v0.1.0, Phases 1–8 implemented).** Authentication,
> the desktop/mobile shell, Linux integration, Docker management and the multi-catalog
> [App Store](docs/app-store.md) work end to end. Signed Linux packages, supervised version updates,
> rollback and recovery passed disposable Linux-host acceptance. See the [roadmap](docs/roadmap.md)
> and [packaging guide](docs/packaging.md) for supported hosts and operations.

## What works today

- **Secure first-run setup.** The first administrator can only be created with a one-time token
  stored on the server, so nobody else on the network can claim the instance.
- **Authentication.** Password hashing with scrypt, server-side sessions (only hashes are stored),
  optional TOTP two-factor authentication with replay protection and recovery codes, brute-force
  lockouts, and session management.
- **Authorization.** Administrator, Operator and Viewer roles built on fine-grained permissions
  that the API and the agent enforce independently. Includes user administration and a structured
  audit log.
- **Privileged agent.** A separate root process that executes only a fixed registry of validated
  operations over an authenticated Unix socket. There is no generic shell endpoint.
- **Real host data.** OS, kernel, CPU, memory, uptime, hardware model (including Raspberry Pi
  detection) and capability detection for systemd, journald, Docker, Tailscale and sensors. Missing
  data is explained, never invented.
- **Web client.** React, glass UI, Turkish by default with English available, accessible forms,
  and a mobile-friendly layout.
- **Desktop and host management.** Persistent windows, themes, virtual desktops, live Linux metrics,
  systemd/journald tools and Docker discovery/lifecycle with explicit ownership and protection rules.
- **App Store.** Runtime catalog readers, safe synchronization, architecture variants, rich forms,
  policy, encryption, immutable images, health-aware rollback, progress streams, durable recovery,
  lifecycle and owned-data transfer. Scope and verification are in [app-store.md](docs/app-store.md).

## Install on Linux

On a fresh Debian 12+, Ubuntu 22.04+ or compatible APT/systemd host (arm64 or amd64):

```bash
curl -fsSL https://github.com/goktugcy/everyos/releases/latest/download/install.sh | sudo bash
```

No repository clone, Node.js or pnpm installation is needed. The installer selects the host
architecture, installs missing verification prerequisites and verifies the signed release and
package before installation. The script is trusted through HTTPS from the official release;
its embedded publisher key verifies subsequent downloads. For independent trust-key verification,
script inspection and the manual installation alternative, see [docs/packaging.md](docs/packaging.md).

After installation, read `/var/lib/everyos/setup-token` locally with administrator privileges and
open the web setup through your reverse proxy or an SSH tunnel to port 7470. The API binds to
loopback by default; see [remote-access.md](docs/remote-access.md). Existing installations update
through Settings → About, Updates → EveryOS or the authenticated CLI.

## Quick start (development)

Requirements: Node.js 26 and pnpm 12.

```bash
pnpm install
pnpm dev            # http://127.0.0.1:5173 — the setup token is printed in the console
```

Other commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e`. See
[docs/development.md](docs/development.md).

## Architecture in one paragraph

A **Hono** API runs as the unprivileged `everyos` user, serves the **React** client, stores state in
**SQLite** (`node:sqlite`, WAL, versioned migrations with automatic backups) and talks to a small
**privileged agent** over a Unix socket using a typed, mutually authenticated protocol. There are no
native addons: the build produces two bundled server files plus static assets that run unchanged on
ARM64 and AMD64. Details: [docs/architecture.md](docs/architecture.md) ·
[docs/security-model.md](docs/security-model.md) · [docs/contracts.md](docs/contracts.md) ·
[docs/decisions.md](docs/decisions.md).

## Documentation

| Topic                               | Document                                                             |
| ----------------------------------- | -------------------------------------------------------------------- |
| Architecture                        | [docs/architecture.md](docs/architecture.md)                         |
| Security model                      | [docs/security-model.md](docs/security-model.md)                     |
| Configuration                       | [docs/configuration.md](docs/configuration.md)                       |
| HTTP API                            | [docs/api.md](docs/api.md)                                           |
| Contracts (apps, widgets, catalogs) | [docs/contracts.md](docs/contracts.md)                               |
| Catalog format research             | [docs/research/catalog-formats.md](docs/research/catalog-formats.md) |
| Development                         | [docs/development.md](docs/development.md)                           |
| Roadmap                             | [docs/roadmap.md](docs/roadmap.md)                                   |
| Contributing                        | [CONTRIBUTING.md](CONTRIBUTING.md)                                   |
| Reporting vulnerabilities           | [SECURITY.md](SECURITY.md)                                           |

## License

The license has not been chosen yet. Until a `LICENSE` file is added, all rights are reserved by
the author.
