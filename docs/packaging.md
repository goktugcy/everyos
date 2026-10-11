# Linux packaging and operations

EveryOS ships Debian packages for arm64 and amd64. The package includes the pinned Node 26
runtime, API, privileged agent, update worker, CLI and pre-compressed web client. Target hosts
use systemd 248+, glibc 2.34+ and kernel 5.14+: Debian 12+, Ubuntu 22.04+ and compatible modern
64-bit Raspberry Pi distributions. This is not a macOS installer.

## Build and release

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
python3 scripts/package.py --arch arm64
python3 scripts/package.py --arch amd64
node scripts/sign-release.ts --version 0.1.0 --key-file /secure/release-private.pem \
  --notes-file docs/release-notes.md
```

`packaging/node-runtime.json` pins the official runtime version and SHA-256 for each architecture.
The builder verifies the download before extracting the executable and includes Node's license
and the server bundle's dependency license notices. It builds POSIX tar/ar archives on Linux or
macOS; package creation does not require a host Node installation on the target. `--version`,
`--dist` and `--output` support disposable acceptance fixtures, without changing source versions.

The tag must match `package.json`. `.github/workflows/release.yml` checks, builds and uploads both
packages, then signs in the protected GitHub `release` environment using
`EVERYOS_RELEASE_PRIVATE_KEY` (Ed25519 PEM). Maintain release notes and minimum upgrade version
when preparing a release. The signer derives the schema version from the ordered migration list;
`--schema-version` is an explicit override for controlled fixtures. The release job publishes `.deb` assets,
`release.json`, `install.py`, `install.sh` and `install.sh.sig` to the public `goktugcy/everyos`
repository, explicitly selecting
the workflow's `GITHUB_REPOSITORY`. An owner must configure
the signing secret and environment protection before publishing; no production private key or
invented trust anchor is committed.

The signer also writes `everyos-release-public.pem` and prints the SHA-256 fingerprint of its
DER-encoded SubjectPublicKeyInfo. The workflow publishes this public key with the release;
independently distribute the fingerprint before first installation. The private Ed25519 key
must remain outside source control, with restricted permissions and a secure backup, and must
stay the same for subsequent releases. Configure it as `EVERYOS_RELEASE_PRIVATE_KEY` in the
GitHub `release` environment. Replacing it requires a separately authorized trust migration;
do not generate a new key for every release.

After publishing a version tag, confirm that the protected workflow succeeded, the release is
public, and its signed `release.json` binds both downloadable package hashes. A tag or unsigned
package alone is not a completed release. The initial release is `v0.1.0`.

The signed manifest binds the exact bytes, size, SHA-256, version, architecture, minimum source
version, database schema version, publication time, expiry and plain-text notes. Normal updates
reject expired metadata and downgrades. Previously verified recovery packages may outlive the
metadata expiry; their signature, hash and architecture remain mandatory.

## First installation

For a fresh supported Linux host, install without cloning the repository:

```sh
curl -fsSL https://github.com/goktugcy/everyos/releases/latest/download/install.sh | sudo bash
```

This command trusts the bootstrap script delivered over HTTPS by the official GitHub release.
The generated script embeds the reviewed Python installer and the publisher's Ed25519 public key;
it does not fetch an additional installer script. It checks the platform before changing the host,
refreshes the host's existing APT package lists, installs missing `python3`, `openssl` and
`ca-certificates` through those sources, then verifies the signed metadata and exact
architecture-specific package. No Node.js, pnpm or
Git checkout is required. `curl` and a working HTTPS certificate store are needed to fetch the
script. Only arm64 and amd64 APT/systemd hosts meeting the minimum versions above are supported.

The signer also publishes a detached Ed25519 `install.sh.sig` over the exact script bytes. To
inspect and verify before execution, download the script and its signature, independently obtain
and verify the publisher public key, then run:

```sh
openssl pkeyutl -verify -pubin -inkey everyos-release-public.pem -rawin \
  -in install.sh -sigfile install.sh.sig
sudo bash install.sh
```

The production public-key fingerprint (SHA-256 of DER SubjectPublicKeyInfo) is
`a6fe59f9100da36a9551dcfab392ee1e69b93f788bfdb7c81169d65c111d0cce`.
Compare it against an independently trusted copy before using the manual verification path.
The one-command path does not independently verify the script before executing it.

For a manually supplied trust anchor, the standalone Python installer remains available:

Obtain `install.py` and the publisher's **public** Ed25519 PEM from a trusted distribution channel.
Verify the public-key fingerprint independently, then place the key in a root-owned file with
no symlink or writable ancestor. Do not trust a key supplied by the same unverified download.

```sh
sudo apt-get update
sudo python3 install.py --public-key /root/everyos-release.pem
sudo everyos status
sudo everyos doctor
```

The installer verifies the signed release and package identity before invoking APT for the
verified local package and its declared dependencies. It does not add repositories, install
Docker/Tailscale or change existing containers. Dependencies include
`libatomic1`, which the bundled ARM64 runtime requires. Installation succeeds only after the
real API and agent report ready. The first-run token is stored in `/var/lib/everyos/setup-token`;
read it locally for the setup wizard, rather than placing it in logs or commands.

The API listens on loopback port 7470. Configure an existing reverse proxy or Tailscale Serve
using [remote-access.md](remote-access.md). Configuration files are dpkg conffiles: upgrades keep
owner changes, and maintainer scripts do not rewrite their contents.

| Path                        | Owner / purpose                                               |
| --------------------------- | ------------------------------------------------------------- |
| `/usr/lib/everyos`          | root-owned application and bundled runtime                    |
| `/etc/everyos/config.yaml`  | root:everyos 0640 API configuration                           |
| `/etc/everyos/agent.yaml`   | root 0600 agent policy                                        |
| `/etc/everyos/agent.key`    | root:everyos 0640 mutual-authentication key                   |
| `/etc/everyos/release.json` | root 0600 release source and public trust anchor              |
| `/var/lib/everyos`          | everyos-owned database, homes, wallpapers and backups         |
| `/var/lib/everyos-agent`    | root-private deployment state; inaccessible to the API        |
| `/var/lib/everyos-updates`  | root-private packages, job, transaction and recovery snapshot |
| `/run/everyos/app-configs`  | root-private, host-visible tmpfs for embedded Compose configs |

Legacy `/var/lib/otuken` databases are never silently replaced by a fresh installation. The
package refuses that installation until the owner backs up the old installation and explicitly
migrates it. Preserve the original secret and agent keys; their cryptographic contexts remain
compatible. Move persistent data while both old services are stopped, configure paths, rename
`otuken.db` to `everyos.db` with its WAL/SHM files, and review root-owned app-state paths before
starting the new services. Existing EveryOS development installations also require an explicit
backup and migration into production paths. The bootstrap installer refuses an existing EveryOS
database; regular upgrades use the authenticated update workflow.
The shell bootstrap checks this before installing prerequisites, and removes its root-private
temporary installer/key directory on success or failure. Persistent release trust and the
verified recovery package remain available for future authenticated updates.

## CLI

```sh
everyos version
everyos status
sudo everyos doctor
everyos backup
everyos restore BACKUP_ID --confirm
everyos update
everyos update --apply --confirm
```

Authenticated commands prompt for username, hidden password and optional TOTP/recovery code.
For automation, `--credentials-stdin` accepts a JSON object containing `username`, `password`
and optional `otp`. Keep credentials out of command arguments and shell history. `--url` accepts
an HTTPS origin or local loopback HTTP origin; certificate verification stays enabled. All backup,
restore and update commands use the same API authorization, password checks, CSRF and audit as
the web client. The CLI has no privileged bypass or generic shell operation.

Backups include the database, configuration, wallpapers and all account homes. App-data backup
remains an explicit app selection in the Backups UI. A database restore requires administrator
confirmation and restarts the supervised API; browsers must sign in again.

## Remote version updates and recovery

Use Updates → EveryOS or `everyos update --apply --confirm`. A fresh local safety backup is
verified and pinned before installation; its database and all account homes are mandatory.
The root agent accepts only version, backup ID and explicit confirmation, never a download URL,
script, key or command. Source configuration is root-owned. HTTPS destinations and redirects
must resolve to public addresses; the validated address is pinned for the TLS connection.
Downloads have size, idle-time and absolute-time limits. A root-configured `file:` source supports
offline, signed releases and acceptance tests; it still requires signatures and package checks.

The independent `everyos-update.service` stages and re-verifies the new package and previous
recovery package before downtime. It checks free space and dpkg locks, stops only EveryOS's API
and agent, records a durable transaction and takes an offline integrity-checked SQLite snapshot
including WAL/SHM. It installs with `--force-confold`, restarts both services and verifies health,
dpkg/application version and database schema. HTTP work and scheduled jobs are held during this
maintenance window. Homes, wallpapers, secrets and existing application containers are untouched
by a release migration; **release migrations must modify only the EveryOS database**. Data-format
changes outside SQLite need a separately designed migration/recovery contract before publication.

If installation or health verification fails, the worker re-verifies and reinstalls the prior
package, restores the offline database snapshot and starts the prior services. A killed worker
or reboot resumes recovery from its root-private transaction. APT updates exposed through the
ordinary package tab exclude EveryOS, which has its own signed update workflow. A manually
installed package without a verified cached recovery artifact cannot self-update safely; use the
verified bootstrap installer for the initial production installation.

Ordinary APT upgrades also request the currently installed EveryOS version explicitly, preventing
dependency resolution from silently replacing it with an unsigned repository candidate.

```sh
sudo journalctl -u everyos-update.service
sudo systemctl status everyos-api.service everyos-agent.service
sudo everyos doctor
```

If recovery itself fails, the transaction and maintenance marker remain and systemd retries the
worker. Review the root journal and package-manager state before restarting `everyos-update`.
Do not delete the recovery snapshot or marker to force an unverified database/binary combination.
The API audit records the administrator's request and backup ID. The root journal and fsynced
`/var/lib/everyos-updates/audit.jsonl` record progress and final outcome without command output or
secrets; this survives database rollback and a volatile journal configuration.

## Hardening and removal

The API runs as `everyos`, with no capabilities, `NoNewPrivileges`, a read-only system, private
devices/tmp, protected homes/kernel settings and one writable data root. Additional file-manager
write roots or backup disks require explicit systemd `ReadWritePaths` drop-ins. Access under
`/home` also needs a deliberate `ProtectHome` adjustment. Configuration alone cannot defeat the
unit's filesystem policy.

The agent and updater run as root because APT, configured account PTYs and dpkg need host access.
They protect kernel settings, modules/control groups, realtime scheduling and address families.
They deliberately retain the filesystem/device/setuid access those operations need; Node's JIT
also prevents a blanket executable-memory prohibition. The typed registry, permissions, strict
schemas, policy, limits and audit remain the primary privileged-operation boundary.
The app-config tmpfs is a real host mount, so Docker can read its bind sources outside the agent's
namespace. A private `TemporaryFileSystem` would not satisfy that requirement.

```sh
sudo apt-get remove everyos
sudo apt-get purge everyos
```

Removal stops/disables only EveryOS units and unmounts its own transient configs. Purge removes
packaged conffiles and binaries but retains account data, homes, archives, secret keys, root app
state, update cache and the service account. Erasing retained data is a separate explicit owner
action. Existing containers, volumes, images, SSH, reverse proxies and Tailscale are never removed.

To reproduce the disposable-host tests, build both real 0.1.0 packages, run
`python3 tests/phase8/fixtures.py`, copy the selected architecture's signed fixtures to the VM's
root-owned `/srv/everyos-releases` and install using that `file:` source and the generated **test**
public key. Run `tests/phase8/acceptance.py --disposable-host` only in a newly created
`lima-everyos-phase8*` VM. `tests/phase8/restore.py` runs after reinstalling the retained verified
package and verifies CLI restore under the real systemd unit. Fixtures include a deliberately
failed database migration and failed pre-install script; they must never be published.
Validation results are recorded in [phase8-acceptance.json](phase8-acceptance.json).

Runtime requirements: [Node BUILDING](https://github.com/nodejs/node/blob/main/BUILDING.md).
Unit semantics: [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
Conffile handling: [Debian policy](https://www.debian.org/doc/debian-policy/ch-files.html).
