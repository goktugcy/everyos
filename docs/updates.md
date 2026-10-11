# Update manager (Phase 7)

## EveryOS version updates (Phase 8)

Settings → About and Updates → EveryOS share the same version-update panel, showing the real
installed/available version, signed release notes and supervised job progress. Administrators
can check and install directly from either screen. The same administrator-approved workflow
is available through `everyos update`.
It verifies the publisher signature, package hash/architecture/upgrade path and a fresh safety
backup of the database and all account homes. A separate systemd worker survives API/agent
restarts and recovers the prior package **and database** after a failed upgrade. Root-owned release
trust configuration and a verified previous package are required; development mode cannot install
host packages. See [packaging.md](packaging.md) for installation, release signing and recovery.

The default release source is `https://github.com/goktugcy/otuken/releases`. The verified
installer records this source and the independently supplied publisher public key in root-owned
`/etc/everyos/release.json`. Checks read `latest/download/release.json`; installation downloads
`download/v<VERSION>/everyos_<VERSION>_<ARCH>.deb` and verifies its signed identity and hash.
The browser cannot change the source or trust key. A production signing secret and a published
signed release are required before this default source can supply a live update.

## Operating-system package updates

The **Updates** app (`everyos.updates`) lists upgradable APT packages, explains each one and runs
package-list refreshes and upgrades as background jobs. Nothing ever starts on its own: EveryOS
never upgrades the operating system automatically. Scheduling a refresh or a security upgrade is
an explicit choice in the scheduler ([tasks.md](tasks.md)).

## What it shows

- Upgradable packages from `apt list --upgradable` (via the agent's cached collector), with the
  installed and candidate versions, the suites they come from, and whether the update comes
  from a security suite.
- Package details from `apt-cache policy` and `apt-cache show`: section, installed size,
  description, homepage, maintainer and origins.
- Job history (the last 50 jobs) with the end of apt's output (64 KiB), the user, the outcome and
  the number of upgraded packages.

## Jobs

| Action  | Command                                                       |
| ------- | ------------------------------------------------------------- |
| Refresh | `apt-get update`                                              |
| Upgrade | `apt-get -y --no-remove … install --only-upgrade -- <names…>` |

The all-packages action resolves the current upgradable package list and excludes EveryOS. An
explicit APT request for EveryOS is refused: self-updates use the signed release workflow above.

Upgrades are unattended and conservative:

- `--no-remove`: an upgrade that would remove a package fails instead.
- `--force-confdef --force-confold`: locally modified configuration files are kept.
- `DEBIAN_FRONTEND=noninteractive`, `NEEDRESTART_MODE=l` (needrestart only lists services) and
  `APT_LISTCHANGES_FRONTEND=none`.
- `install --only-upgrade` never installs a package that is not installed yet. Package names are
  validated (`^[a-z0-9][a-z0-9+.-]{0,127}$`) and passed after `--`.

One job runs at a time; another request answers `409`. A job runs in the background,
independently of the HTTP request; its output streams over SSE (`/api/updates/jobs/:id/events`)
and its result is stored, audited (`updates.refresh`, `updates.upgrade`) and announced in the
notification center (`updates-installed`, `updates-failed`). A busy dpkg lock is reported as
`busy`. A job interrupted by an API restart is marked `interrupted`; its real outcome on the host
is unknown and the package list shows the current state.

## Permissions and modes

- Viewing needs `system:read`; refreshing and upgrading need `system:manage` (administrators). The
  agent re-checks the permission.
- A development agent never changes host packages: `apt.refresh` and `apt.upgrade` are denied by
  its policy unless the clearly labelled development simulator answers them (used by the
  browser tests).

## API

| Method | Path                           | Permission      | Notes                                                                       |
| ------ | ------------------------------ | --------------- | --------------------------------------------------------------------------- |
| `GET`  | `/api/updates`                 | `system:read`   | `{ updates, running }`                                                      |
| `GET`  | `/api/updates/packages/:name`  | `system:read`   | Package details                                                             |
| `GET`  | `/api/updates/jobs`            | `system:read`   | History                                                                     |
| `GET`  | `/api/updates/jobs/:id`        | `system:read`   |                                                                             |
| `GET`  | `/api/updates/jobs/:id/events` | `system:read`   | SSE: `line` events, then `done`                                             |
| `POST` | `/api/updates/refresh`         | `system:manage` | `{}` → `202` job                                                            |
| `POST` | `/api/updates/upgrade`         | `system:manage` | `{ all: true, confirm: true }` or `{ packages, confirm: true }` → `202` job |

## Limitations

- Kernel and firmware updates may need a reboot; EveryOS does not reboot the host.
- Held packages and phased updates are left to apt's own rules.
- Only APT is supported (Debian, Ubuntu, Raspberry Pi OS).
