# Backup and restore (Phase 7)

The **Backups** app (`otuken.backups`) creates, verifies, downloads, uploads and restores
backups of Otuken itself and of the data of apps installed through the App Store. Backups run
as background jobs, one at a time, independent of the HTTP request that started them.

## What a backup contains

| File                       | Contents                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otuken.db.gz`             | A consistent snapshot of the Otuken database, taken with SQLite's online backup API (never a file copy), with the `sessions` table emptied and the file vacuumed. |
| `config.yaml`              | The configuration file, when it exists and is readable. For reference only; it is never restored automatically.                                                   |
| `wallpapers.tar.gz`        | Uploaded wallpapers (`<dataDir>/wallpapers/<userId>/<file>`).                                                                                                     |
| `apps/<appId>.data.tar.gz` | The app data directory of each selected app (see below).                                                                                                          |
| `manifest.json`            | Format version, creation time and trigger, Otuken and schema versions, contents, and the size and SHA-256 of every file. Written last.                            |

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
  dir: /mnt/usb/otuken-backups # default <dataDir>/backups/archives (e.g. a separate disk)
  minFreeMiB: 1024 # backups never leave less free space than this
  maxUploadMiB: 65536 # largest archive accepted by "Upload backup"
```

The location must be a directory owned by the API user and not world-writable; otherwise backups
are disabled with a reason instead of failing startup. `OTUKEN_BACKUP_DIR` overrides `dir`.

## App data

An app's data can be backed up when **every** mount of its Compose project is a bind mount
under its Otuken app data directory (the same rule as copying data between installs). Apps
with named volumes or host paths are shown as unsupported: Otuken does not pretend it can
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

| Method   | Path                        | Permission        | Notes                                                |
| -------- | --------------------------- | ----------------- | ---------------------------------------------------- |
| `GET`    | `/api/backups`              | `backups:manage`  | Backups, running and last job, settings, apps, space |
| `POST`   | `/api/backups`              | `backups:manage`  | `{ apps, note? }` → `202` job                        |
| `POST`   | `/api/backups/cancel`       | `backups:manage`  | Cancels the running job                              |
| `PUT`    | `/api/backups/settings`     | `backups:manage`  | `{ keep, appData }`                                  |
| `GET`    | `/api/backups/:id`          | `backups:manage`  |                                                      |
| `POST`   | `/api/backups/:id/verify`   | `backups:manage`  |                                                      |
| `PUT`    | `/api/backups/:id/pin`      | `backups:manage`  | `{ pinned }`                                         |
| `DELETE` | `/api/backups/:id`          | `backups:manage`  |                                                      |
| `GET`    | `/api/backups/:id/preview`  | `backups:restore` | Verifies, then describes the restore                 |
| `POST`   | `/api/backups/:id/restore`  | `backups:restore` | `{ settings, apps, password, confirm: true }` → job  |
| `POST`   | `/api/backups/:id/download` | `backups:restore` | `{ password }` → `{ url }` (single use, 60 s)        |
| `GET`    | `/api/backups/:id/download` | `backups:restore` | `?ticket=` → `application/x-tar`                     |
| `POST`   | `/api/backups/upload`       | `backups:restore` | Raw tar body, `Content-Length` required              |

The downloaded archive is a plain tar with one top-level directory `otuken-backup-<id>/`; it can
be inspected with standard tools (`tar -tf`).

## Limitations

- Volume-based app data is not backed up (no volume-aware strategy yet), and neither are users'
  home folders in the file manager.
- Restoring onto a different host requires copying `secret.key` first; restoring app data
  needs the app to be installed with the same id. A full disaster-recovery flow (re-deploying
  apps from restored records) is not implemented.
- `config.yaml` is never written by Otuken; compare and restore it manually.
- Backups are not encrypted at rest beyond file permissions; put the backup location on an
  encrypted disk if the host's threat model requires it.
