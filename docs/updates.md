# Update manager (Phase 7)

## EveryOS version updates (Phase 8)

The production API checks the signed release feed automatically every five minutes, starting
about 20 seconds after service startup, so a published release is announced within about six
minutes. It inspects cached status each minute and retries a failed remote check after 15
minutes, preserving verified cached data. Each remote check downloads only the small signed
`release.json`. No browser or signed-in user is
needed for discovery. Each new compatible version creates one durable update notification;
repeated checks preserve read/dismiss state. Popup preferences are honored. Its action opens
Settings → About, which also displays the real last-check time and automatic-check cadence.
Discovery never installs an update.

Settings → About and Updates → EveryOS share the same version-update panel, showing the real
installed/available version, signed release notes and supervised job progress. Administrators
can check and install directly from either screen without entering the EveryOS password again.
An authenticated, unlocked administrator session and explicit update confirmation are required;
linked Linux privileges are checked independently. Older clients may send an optional legacy
`password` field, but installation neither requires nor verifies it.
The same administrator-approved workflow
is available through `everyos update`.
It verifies the publisher signature, package hash/architecture/upgrade path and a fresh safety
backup of the database and all account homes. A separate systemd worker survives API/agent
restarts and recovers the prior package **and database** after a failed upgrade. Root-owned release
trust configuration and a verified previous package are required; development mode cannot install
host packages. See [packaging.md](packaging.md) for installation, release signing and recovery.

The signed-in desktop watches update status even while both update panels are closed. Once the
worker reports a finished, successful job and the API reports that job's target version, a tab
running an older bundle flushes pending preferences and reloads once. A session-storage receipt
prevents the retained completed job from causing a reload loop; a current bundle never reloads.
Polling and visibility recovery cover missed events during API restarts. Failed, unfinished and
rolled-back jobs do not trigger this refresh.

The shared release stream retains its latest status for windows opened later in the same unlocked
session with `system:read`. Locking, signing out, changing sessions or losing that permission clears
the snapshot. Recovery reads run one at a time with a bounded timeout; a newer stream status
invalidates an older HTTP response without aborting a healthy request.

The default release source is `https://github.com/goktugcy/everyos/releases`. The verified
installer records this source and the independently supplied publisher public key in root-owned
`/etc/everyos/release.json`. The one-command `install.sh` bootstrap embeds the same public key;
its initial trust comes from HTTPS to the official GitHub release, with an independently verified
manual alternative documented in [packaging.md](packaging.md). Checks read
`latest/download/release.json`; installation downloads
`download/v<VERSION>/everyos_<VERSION>_<ARCH>.deb` and verifies its signed identity and hash.
The browser cannot change the source or trust key. A production signing secret and a published
signed release are required before this default source can supply a live update.

The first signed public release is
[v0.1.0](https://github.com/goktugcy/everyos/releases/tag/v0.1.0). The published metadata, both Linux
packages, public key and installer were downloaded without GitHub authentication and verified
using the actual update transport. See [the publication record](phase8-acceptance.json) for the
publisher fingerprint, source commit and package hashes.

The same release now includes the self-contained `install.sh` bootstrap and its detached
signature. The public one-command installation was verified on a fresh disposable Debian 12
ARM64 host; its record is `verification.oneCommandBootstrap` in the acceptance file. These assets
were added from a follow-up commit without replacing the original tag, packages or signed manifest.

After the owner's repository rename, the updater and bootstrap installer recognize the old
`https://github.com/goktugcy/otuken/releases` root as the new EveryOS source. Existing installations
use the new URL on configuration reads, without rewriting their root-owned file or replacing the
publisher public key. Other explicitly configured sources remain unchanged. The release workflow
publishes to its own `GITHUB_REPOSITORY`, rather than inferring an old Git remote. The repository
is public, so clients do not require a GitHub token; public visibility alone does not publish a
signed release.

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

The UI releases its action buttons on every terminal job outcome, including failures. It tracks
the job independently of the selected tab and polls the persisted status while it is running,
so a lost SSE connection cannot leave the screen locked. Starting a request also locks the
actions until the request settles, preventing duplicate submissions.

Preflight failures are retained in the job's error field and bounded output, even when APT
never started. Both the live log and history show the localized reason. A missing Linux mapping
or sudo authorization is distinguished from an APT error or agent connection failure.

## Permissions and modes

- Viewing needs `system:read`; refreshing and upgrading need `system:manage` (administrators). The
  agent re-checks the permission.
- Production mutations also require a linked Linux account with actual sudo rights. Linux sudo
  verification uses the selected duration, including indefinite account-wide grants; legacy
  requests without a duration retain five-minute session grants. Linking alone does not grant
  sudo. A failed job offers **Verify sudo access** in the Updates app, using the same credential
  flow as Settings → Account. After authorization, the administrator explicitly retries the
  refresh or upgrade. Passwords are never stored or included in update logs.
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

## Restart and shutdown

**Restart required.** The agent reports `power.reboot.status` (cached for 5 s):

- `flag`: Debian/Ubuntu's `/run/reboot-required` exists; `/run/reboot-required.pkgs` names the
  packages that asked for it (validated names, at most 200).
- `kernel`: `/boot` holds a kernel of the running flavour (`-generic`, `-raspi`, `-rpi-v8`…) that is
  newer than the running one, or the running one was removed. Releases compare by their numeric
  parts, so `6.8.0-10` is newer than `6.8.0-9`. `/boot` is used rather than `/lib/modules`, which
  services with `ProtectKernelModules` cannot see. Hosts without kernels in `/boot` report only
  the flag.

The Updates app shows a notice with **Restart now** while a restart is required, and the monitor
raises the `reboot-required` condition (resolved after the restart).

**Restart and shut down** are in the EveryOS menu (and the mobile shell) for `system:manage`. The
dialog asks for the account password, confirms the action by name, and lists running work that a
restart would interrupt: an EveryOS update being installed, a backup or restore, app jobs, an
APT job, and file transfers. An EveryOS update in progress always blocks; the others can be overridden explicitly
(`force`). The agent schedules `systemctl reboot|poweroff` 5 s later through a transient systemd
timer (`everyos-power`), so the API can answer first; a second request while one is pending is a
conflict. Production also requires a linked Linux account with sudo authorized, like upgrades.
The action is audited (`system.power`, with any overridden blockers) and announced to everyone
who can see the system (`power-scheduled`). The browser shows a waiting screen and reloads once
the host answers again. A development agent never powers off the host; the simulator only logs.

| Method | Path                         | Permission      | Notes                                                                                                 |
| ------ | ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/system/power/reboot`   | `system:read`   | `{ source, required, reasons, packages, kernel }`                                                     |
| `GET`  | `/api/system/power/blockers` | `system:manage` | `{ blockers }`                                                                                        |
| `POST` | `/api/system/power`          | `system:manage` | `{ action, confirm, password, force? }` → `202 { source, action, at }`; `409` with `details.blockers` |

## Limitations

- Firmware updates outside APT (for example the Raspberry Pi EEPROM) are not detected as
  requiring a restart.
- Held packages and phased updates are left to apt's own rules.
- Only APT is supported (Debian, Ubuntu, Raspberry Pi OS).
