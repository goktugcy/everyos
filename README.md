<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/everyos-white.png" />
    <img src="apps/web/public/everyos.png" width="420" alt="EveryOS" />
  </picture>
</p>

<h1 align="center">Your personal OS, in your browser.</h1>

<p align="center">
  Your files. Your apps. Your own space.<br />
  A personal desktop, powered by the Linux machine you control.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="https://github.com/goktugcy/everyos/releases">Releases</a> ·
  <a href="#explore-everyos">Features</a> ·
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <img src="docs/images/everyos-desktop.png" width="1280" alt="EveryOS desktop with glass panels, app shortcuts, a dock and the mountain wallpaper" />
</p>

<p align="center"><em>A workspace that feels like yours, wherever you open it.</em></p>

## Meet EveryOS

EveryOS is a self-hosted **personal OS experience** that brings your files, applications and
workspace together in a browser. It runs on your existing Linux installation and gives you a
familiar desktop: windows, folders, a dock, search, settings and a space to make your own.

Keep documents in your personal home, organize your desktop, install self-hosted apps and see
what your machine is doing. Open the same workspace from a laptop or use the mobile interface
from your phone. Your data lives on the machine you choose to host it on.

The interface is available in **English** (the default), **Turkish, German, Spanish, French,
Italian, Japanese, Korean, Russian and Simplified Chinese**. Each person picks their own language.

## Explore EveryOS

### A desktop that remembers you

Move and resize windows, snap them into place and return to your saved layout. Switch between
virtual desktops, pin apps to the dock and find them through the launcher. Widgets, notifications
and the Pulse shelf keep useful information close to your work.

### Your home, connected

Bring Home Assistant into your workspace with a dedicated panel and desktop widgets. Choose
all accessible entities without entering their IDs. Devices are recognized with their reported
brand and model, logos and type symbols. Browse rooms and live states in a calm device overview,
then open details for sensors and supported controls. Existing connection scopes stay under your control; access tokens
remain on the server. Learn more in the [Home Assistant guide](docs/home-assistant.md).

### AI assistants in your workspace

Chat with a **local model** on your own server, **Hermes Agent** or **OpenClaw** from EveryOS.
AI Assistants finds model servers such as Ollama, LM Studio, llama.cpp and vLLM, can install a
shared Ollama (with NVIDIA or AMD GPU acceleration when available) and download models for you,
and sets up agents step by step with a local or cloud model. Live menu bar indicators show state
and open chat quickly. Conversations and keys are encrypted on your server. Learn more in the
[assistant guide](docs/ai-agents.md).

### Your files, at home

Each account has a private home with Desktop, Documents, Downloads, Pictures, Music and Videos.
The desktop shows the contents of your Desktop folder, so folders and files behave consistently
across views. Select several items, draw a selection rectangle, drag between folders, preview
images and edit text. Deleted files go to a private trash where they can be restored.

Administrators can also make selected host locations available with explicit access rules. Plug
in a USB disk and it appears on the desktop and in Files; mount it with one click, and EveryOS
can mount it by itself whenever it is plugged in. EveryOS never formats a disk or touches the
system disk. Connect your own Google Drive to browse it in Files and copy files both ways; every
upload and copy shows its speed and time left in the menu bar, the dock and the pulse. Learn
more in the [file manager](docs/files.md), [disks](docs/disks.md), [Google Drive](docs/drive.md)
and [transfers](docs/transfers.md) guides.

### Apps on your own machine

Browse supported catalogs in the App Store, install self-hosted applications and follow their
deployment progress. Open the Docker app to inspect containers and manage supported lifecycle
actions. EveryOS distinguishes its own deployments from external and protected resources.

Change an installed app's settings later, get notified when its catalog definition changes, and
apply the update with your values kept. Deployment rollback and selected app-data backups are part
of the same workspace.
Docker must be installed on the host to use these features; the EveryOS installer does not install
it automatically. See the [App Store](docs/app-store.md) and [Docker](docs/docker-management.md) guides.

### Make it look like you

Start with the EveryOS mountain wallpaper, then choose a different background, upload your own
image or give each virtual desktop its own look. Seven themes, accent colors, glass effects,
icon sizes and rendering modes let you adjust the interface to your device and taste.

Choose a folder-icon preset or use your own image, globally or for an individual folder.
Your appearance settings stay with your account.

<details>
<summary>View the default EveryOS wallpaper</summary>

![EveryOS mountain wallpaper](apps/web/public/wallpapers/everyos-mountains.png)

[Download the original wallpaper](apps/web/public/wallpapers/everyos-mountains.png) ·
[Visual identity and assets](docs/branding.md)

</details>

### Linux, within reach

See real CPU, memory, storage and network readings in System Monitor. Inspect services and logs,
manage host packages and schedule supported tasks. Restart or shut down the host from the EveryOS
menu, with a notice when installed updates need a restart. Notifications can also reach you
through ntfy, Telegram, e-mail or a webhook ([notifications](docs/notifications.md)). The menu bar shows battery and power details
when the Linux host exposes those sensors, including charging state and watts where available.

The browser terminal connects to a real shell with independent windows and themes. An administrator
links each EveryOS user to an existing Linux account in the Users app. Terminal and host file
access use that account’s permissions; system management verifies its existing sudo rights. See
[Linux accounts](docs/linux-accounts.md) and [terminal.md](docs/terminal.md).
Unavailable host capabilities are explained in the interface.

### Your workspace, backed up

Backups include the database, configuration, wallpapers and personal home folders, including
desktop files and trash. Choose app data separately, verify archives and restore through the
authenticated workflow. With a backup passphrase, copies are encrypted and sent off-site to another
disk, S3-compatible storage or Google Drive; an encrypted copy carries the server secret, so a new
machine restores it with the passphrase alone. EveryOS version updates are available from **Settings → About**,
**Updates → EveryOS** and the CLI, with signed packages and supervised recovery.

See [backups](docs/backups.md) and [updates](docs/updates.md) for the operating details.

## Get started

Install on a fresh **Debian 12+, Ubuntu 22.04+ or compatible APT/systemd host**, using
**ARM64 or AMD64**. The detailed kernel, glibc and systemd requirements are in the
[installation guide](docs/packaging.md).

```bash
curl -fsSL https://github.com/goktugcy/everyos/releases/latest/download/install.sh | sudo bash
```

The installer selects your architecture, installs missing prerequisites and verifies the signed
release and package. The application includes its Node.js runtime; no repository clone, Node.js
setup or pnpm installation is required.

The one-command path trusts the bootstrap delivered over HTTPS by the official GitHub release.
For script inspection and independent publisher-key and signature verification, use the
[manual installation instructions](docs/packaging.md#first-installation).

### Open your workspace

1. On the Linux host, read the one-time setup token:

   ```bash
   sudo cat /var/lib/everyos/setup-token
   ```

2. Open one of the network addresses printed by the installer, such as `http://192.168.1.20:7470`
   or your host's Tailscale IPv4 address. The verified installer from 0.1.2 enables all IPv4 interfaces for a new installation,
   including loopback. A client using the Tailscale address must be connected to the same tailnet.
   For HTTPS, turn on Tailscale Serve or local-network HTTPS in **Settings → Security → HTTPS**
   (or use your own HTTPS reverse proxy).
3. Complete the setup wizard, create your administrator account and make the desktop your own.

For an existing EveryOS installation, use **Settings → About** to check for and install a version
update. The initial-installation command refuses an existing database.

## Built around your control

- **Private accounts.** Personal home folders, server-side sessions, two-factor authentication
  with recovery codes, which administrators can require for administrators or everyone.
- **Explicit permissions.** Administrator, Operator and Viewer roles, with permissions enforced
  by the API and agent and security-relevant actions recorded in the audit log.
- **A separate privilege boundary.** The API runs unprivileged; host-management operations pass
  through a validated agent registry. The configured interactive terminal uses its Linux account's
  ordinary permissions.
- **Verified updates.** Publisher signatures, package identity and hashes are checked before
  installation. A supervised worker handles version updates and package/database recovery.

Read the [security model](docs/security-model.md) or use [SECURITY.md](SECURITY.md) to report a vulnerability.

## Project status

EveryOS publishes signed releases for arm64 and amd64 from GitHub; see the
[release notes](docs/release-notes.md). This README describes the current source tree; installed
packages contain the code and assets from their release tag.

Every release comes from a commit of `main` that passed CI: lint, type checks, unit tests and the
browser tests (also over plain HTTP). Updates are verified from the oldest supported version
(`packaging/release-policy.json`), and Linux installation, updates and recovery have recorded
disposable-host acceptance results ([phase8-acceptance.json](docs/phase8-acceptance.json),
[security-acceptance.json](docs/security-acceptance.json)). Planned
work is in the [roadmap](docs/roadmap.md).

## Development

Use **Node.js 26** and **pnpm 12**:

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The development stack prints its temporary setup token in the console.

```bash
pnpm check
pnpm build
pnpm test:e2e
```

The React client, Hono API, SQLite database, privileged agent and update worker are described in
the [architecture guide](docs/architecture.md). See [development.md](docs/development.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) to work on the project.

## Documentation

| Start here                          | Guide                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Installation, CLI and recovery      | [Packaging](docs/packaging.md)                                                                                   |
| Host configuration                  | [Configuration](docs/configuration.md)                                                                           |
| Files, homes and trash              | [Files](docs/files.md) · [Disks](docs/disks.md) · [Google Drive](docs/drive.md) · [Transfers](docs/transfers.md) |
| Self-hosted applications            | [App Store](docs/app-store.md)                                                                                   |
| Docker resources                    | [Docker management](docs/docker-management.md)                                                                   |
| Browser shell access                | [Terminal](docs/terminal.md)                                                                                     |
| Personalization and visual assets   | [Branding](docs/branding.md) · [Folder icons and power](docs/power-and-folder-icons.md)                          |
| Widgets and integrations            | [Widgets](docs/widgets.md)                                                                                       |
| Scheduled operations                | [Tasks](docs/tasks.md)                                                                                           |
| Data protection and version updates | [Backups](docs/backups.md) · [Updates](docs/updates.md)                                                          |
| Remote access                       | [Tailscale](docs/tailscale.md)                                                                                   |
| APIs and extensions                 | [API](docs/api.md) · [Contracts](docs/contracts.md)                                                              |

## License

EveryOS is released under the [MIT License](LICENSE).
