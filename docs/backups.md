# Backup and restore (Phase 7)

The **Backups** app (`everyos.backups`) creates, verifies, downloads, uploads and restores
backups of EveryOS itself and of the data of apps installed through the App Store. Backups run
as background jobs, one at a time, independent of the HTTP request that started them.

New manifests use `format: "everyos-backup"`, `version: 1` and `everyosVersion`. Older
`otuken-backup` manifests with `otukenVersion`, `otuken.db.gz` and the old archive prefix remain
importable and restorable. Renaming archive metadata never changes the checksummed file bytes
or the encryption key identity.

## What a backup contains

| File                       | Contents                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `everyos.db.gz`            | A consistent snapshot of the EveryOS database, taken with SQLite's online backup API (never a file copy), with the `sessions` table emptied and the file vacuumed. |
| `config.yaml`              | The configuration file, when it exists and is readable. For reference only; it is never restored automatically.                                                    |
| `wallpapers.tar.gz`        | Uploaded wallpapers (`<dataDir>/wallpapers/<userId>/<file>`).                                                                                                      |
| `apps/<appId>.data.tar.gz` | The app data directory of each selected app (see below).                                                                                                           |
| `homes.tar.gz`             | Existing EveryOS account homes, including standard folders, Desktop files, folder-name metadata and private trash.                                                 |
| `manifest.json`            | Format version, creation time and trigger, EveryOS and schema versions, contents, and the size and SHA-256 of every file. Written last.                            |

The database holds accounts, desktop layouts, widgets, preferences, catalogs, managed app
records (including their sealed Compose files), scheduled tasks, notifications and the audit
trail.

Each backup is a private directory (`0700`, files `0600`) named `YYYYMMDD-HHMMSS-xxxxxx` (UTC)
under the backup location. Work happens in `.partial-<id>`; the directory only gets its final
name after `manifest.json` is written, so an interrupted backup never looks complete, and
leftovers are removed on start. `info.json` beside the manifest holds mutable state (pin,
upload, last verification).

```yaml
backups:
  dir: /mnt/usb/everyos-backups # default <dataDir>/backups/archives (e.g. a separate disk)
  minFreeMiB: 1024 # backups never leave less free space than this
  maxUploadMiB: 65536 # largest archive accepted by "Upload backup"
```

The location must be a directory owned by the API user and not world-writable; otherwise backups
are disabled with a reason instead of failing startup. `EVERYOS_BACKUP_DIR` overrides `dir`.

## Personal homes

Every manual, scheduled and pre-restore safety backup includes existing homes for accounts in
the database snapshot. These are EveryOS's `<homesDir>/<userId>` directories, not host OS `/home`
folders or arbitrary configured file locations. Capture runs as the unprivileged API; no agent
operation or extra permission is introduced. A bounded tar.gz stream records directories, regular
files and symlinks without following links; special files and other file systems are skipped and
counted in `contents.homes` and shown as excluded entries in the backup list. Limits are
1,000,000 entries and 1 TiB uncompressed across all homes.

File requests for affected accounts are blocked temporarily and pending file operations drain
before capture/replacement. External host changes can still happen: changed files fail capture
rather than producing a falsely verified backup. This is not a snapshot of applications writing
the same files outside EveryOS. Free-space reserves and cancellation apply to the stream.

Restore preview lists homes matched to current account **ids**. The explicit **Restore personal
home folders** checkbox replaces only those homes; newer or removed accounts are not overwritten
or recreated. It needs the normal administrator restore permission, password and confirmation,
and takes a safety backup of current homes first. Current homes with skipped special files or
mounted descendants are refused to prevent removing uncaptured host data. On Linux, mountinfo
also detects bind mounts on the same device ([kernel mountinfo contract](https://www.kernel.org/doc/html/latest/filesystems/proc.html)).

The archive is fully validated before extraction and again while extracting: only declared home
ids, safe relative paths, known parents, unique entries, files, directories and leaf symlinks are
accepted, with counts and sizes matching the manifest. Extraction uses a fresh private directory,
exclusive/no-follow writes and strips special permission bits. Home root directories remain 0700. Directory swaps are rolled back if a later swap fails; old copies are removed only after
all swaps succeed. The API user owns restored files; host uid/gid ownership is not recreated.

Format version 1 remains readable: missing `contents.homes` means an older backup without homes;
new archives explicitly declare `homes.tar.gz` and its checksum. Download/upload, verification,
retention and pinning include it like other backup files. Desktop-only restore does not change
files unless the homes checkbox is also selected.

## App data

An app's data can be backed up when **every** mount of its Compose project is a bind mount
under its EveryOS app data directory (the same rule as copying data between installs). Apps
with named volumes or host paths are shown as unsupported: EveryOS does not pretend it can
capture them consistently. Apps without mounts keep no persistent data.

Consistency comes from **stopping the app**: the API stops a running app through the normal app
lifecycle, the agent archives the directory, and the app is started again afterwards, even when
the copy fails or is cancelled. The agent refuses to read or replace the data of a running app
(`APP_RUNNING`) and holds the app's project lock while it works, so no other app operation can
interleave.

The agent writes the archive itself (directories, regular files and symbolic links with their
mode, owner and times; sockets, pipes and device files are skipped and counted; it stays on one
file system). The API **pulls** it in 512 KiB chunks (`backups.appdata.export.*`), so the agent
only produces what the API has written to disk: there is no unbounded buffering. Restores push
the archive in chunks (`backups.appdata.import.*`); the agent then checks the SHA-256, validates
every member before writing anything (names inside `data/`, no `..`, no absolute paths, parents
before children, no duplicates, only directories, files and symlinks), checks free space,
extracts into a fresh private directory without following links (`O_EXCL | O_NOFOLLOW`; links are
only created as leaves and never written through), strips setuid/setgid bits, and finally swaps
the directory in. Unfinished transfers are released after 10 minutes.

## Space, integrity and retention

- Before a backup the API checks that the database snapshot and each app's data fit while
  keeping `minFreeMiB` free, and it re-checks every 64 MiB while writing. A backup that would
  fill the disk fails with `BACKUP_INSUFFICIENT_SPACE` and is removed.
- Every new backup is verified right away: file sizes and checksums, plus an integrity check
  of a decompressed copy of the snapshot. **Verify** repeats that at any time; a restore always
  does it first.
- Retention keeps the newest `keep` unpinned backups (default 7) and runs after each manual or
  scheduled backup. Pinned backups are never removed automatically.

## Restore

Restoring needs `backups:restore` (administrators), the current password and an explicit
confirmation. The preview shows the verification result, what the database restore would
change (users and app records that return or disappear), which users' desktops can be restored,
whether `config.yaml` differs, and which apps' data can be restored.

Before anything changes, a **safety backup** of the current state is taken (including the
current data of the apps being restored). The scopes are:

- **Desktop and preferences** (live): layout, widgets, preferences and wallpapers of every user
  present both in the backup and now (matched by id). Accounts are untouched. Wallpaper records
  are only restored with well-formed file names.
- **The entire database** (staged): the snapshot is written to `<dataDir>/restore/` and applied
  by the next API start, before the database is opened. The replaced database is kept as
  `<backupDir>/pre-restore-<time>.db` (the three most recent). Migrations then bring an older
  snapshot up to date; a snapshot from a newer schema is refused. Everyone must sign in again
  (sessions are never backed up). When the API runs as a systemd service in production
  (`INVOCATION_ID` is set), it exits with status 75 after staging so the service manager starts it
  again (the Phase 8 unit must restart on failure); otherwise the UI asks for a manual restart.
- **Personal homes** (live, opt-in): as described above, for current account ids only.
- **App data**: per app, as described above. The app must still be installed with the same id.

Database restores are refused for backups made with another installation's secret key
(`keyId`, a fingerprint of the server secret, differs): sealed Compose files, integration
tokens and two-factor secrets could not be decrypted, which could lock administrators out.

## Sensitive data

- Backups never contain sessions, the server secret (`secret.key`) or the agent key. Stored
  secrets stay encrypted with the server secret, so a copied archive alone does not reveal them.
- Archives still contain password hashes and other accounts' data. Downloading needs
  `backups:restore`, the current password and a single-use link valid for one minute; it is
  audited. Uploading needs the same permission and accepts only the expected file names with
  matching checksums, and never overwrites an existing backup.
- Creating, verifying, pinning and deleting need `backups:manage` (operators and administrators).

## Scheduling

The scheduled task type `backup.create` creates a backup with the saved settings (apps whose
data to include) and applies retention. It runs with the task owner's current permissions, like
every task.

## API

| Method   | Path                        | Permission        | Notes                                                       |
| -------- | --------------------------- | ----------------- | ----------------------------------------------------------- |
| `GET`    | `/api/backups`              | `backups:manage`  | Backups, running and last job, settings, apps, space        |
| `POST`   | `/api/backups`              | `backups:manage`  | `{ apps, note? }` → `202` job                               |
| `POST`   | `/api/backups/cancel`       | `backups:manage`  | Cancels the running job                                     |
| `PUT`    | `/api/backups/settings`     | `backups:manage`  | `{ keep, appData }`                                         |
| `GET`    | `/api/backups/:id`          | `backups:manage`  |                                                             |
| `POST`   | `/api/backups/:id/verify`   | `backups:manage`  |                                                             |
| `PUT`    | `/api/backups/:id/pin`      | `backups:manage`  | `{ pinned }`                                                |
| `DELETE` | `/api/backups/:id`          | `backups:manage`  |                                                             |
| `GET`    | `/api/backups/:id/preview`  | `backups:restore` | Verifies, then describes the restore                        |
| `POST`   | `/api/backups/:id/restore`  | `backups:restore` | `{ settings, apps, homes?, password, confirm: true }` → job |
| `POST`   | `/api/backups/:id/download` | `backups:restore` | `{ password }` → `{ url }` (single use, 60 s)               |
| `GET`    | `/api/backups/:id/download` | `backups:restore` | `?ticket=` → `application/x-tar`                            |
| `POST`   | `/api/backups/upload`       | `backups:restore` | Raw tar body, `Content-Length` required                     |

The downloaded archive is a plain tar with one top-level directory `everyos-backup-<id>/`; it can
be inspected with standard tools (`tar -tf`).

## Limitations

- Volume-based app data is not backed up (no volume-aware strategy yet). Arbitrary file roots and
  host OS homes are not captured; only EveryOS-managed personal homes are included.
- Restoring onto a different host requires copying `secret.key` first; restoring app data
  needs the app to be installed with the same id. A full disaster-recovery flow (re-deploying
  apps from restored records) is not implemented.
- `config.yaml` is never written by EveryOS; compare and restore it manually.
- Backups are not encrypted at rest beyond file permissions; put the backup location on an
  encrypted disk if the host's threat model requires it.
