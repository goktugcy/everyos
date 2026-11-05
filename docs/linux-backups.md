# Linux system backups

**Backups → Linux backups** is built into EveryOS, available to administrators with
`backups:restore`. It uses a native BorgBackup repository for file-based Linux recovery.
It is separate from the existing consistent [EveryOS database/app-data backup](backups.md).

## Host preparation

The production agent must run on Linux as root and have a trusted **BorgBackup 1.2.5 or newer
1.x** executable on its executable search path. Borg 2 uses a different CLI/repository format
and is rejected. Borg 1.4.5 is the recommended baseline. Older 1.x versions are rejected because
of the archive authentication issue fixed in 1.2.5. Install and maintain Borg using a trusted
host package or the [official installation instructions](https://borgbackup.readthedocs.io/en/stable/installation.html).
When Borg is missing, **Install** in the Linux backup tab starts a password-confirmed background
installation on APT hosts. The root agent refreshes configured package lists and installs the
fixed `borgbackup` dependency (with required dependencies only). It pins the current EveryOS
package version, refuses package removal and keeps existing configuration files. No package
name, repository or shell command is accepted from the browser. Administrator system permission
and a linked, sudo-unlocked Linux account are required. The browser may close while installation
continues; returning to Backups shows persisted phase/outcome and offers a retry after failure.

Only a stable, compatible Borg 1.x repository candidate is accepted. A repository with no suitable
version (for example an old distribution's 1.2.4 package) produces an actionable error instead of
installing an incompatible engine. Configure suitable trusted repositories or install a compatible
release manually in that case. EveryOS does not add repositories or download arbitrary binaries.
After installation it reprobes the executable and checks its version without restarting the agent;
a package command alone is never treated as proof that backup is ready. Unsupported environments
show why screen-based installation is unavailable. Incompatible existing Borg installations are
left for deliberate manual maintenance. The Debian package recommends Borg; bootstrap installations that disable
recommended packages need it installed separately.

The agent defaults to `/var/backups/everyos-linux`, creating this empty private directory when
running as root. To use other existing destinations, set the agent's configuration:

```yaml
systemBackupDirectories:
  - /srv/backups
  - /mnt/backup-disk
```

Paths and all their ancestors must be root-owned real directories, without group/other write
permission or symlink components. Connected writable disks managed through EveryOS also appear
when they satisfy these checks. Merely opening the screen never mounts/formats a disk. Use a
separate, appropriately protected disk for protection against source disk failure; a directory
on the source disk cannot provide that protection.

Each plan binds its destination path and filesystem identity (filesystem UUID when available,
otherwise device number). A changed/disconnected disk fails the operation. A new repository
lives under `everyos-linux-<plan-id>/repository` with a private identity marker; EveryOS refuses
to adopt an unrelated existing directory. It rechecks identity before each Borg command and
while a job runs. Create/restore reserve at least 1 GiB free space; verification and approved
retention remain usable on a nearly full disk. Restore also checks the archive's original size.
Repository/cache/restore directories are excluded from capture.

## Scope and consistency

The plan wizard shows the actual source/exclusion preview before saving:

- **Linux system only:** `/etc`, `/usr`, `/boot`, legacy binary/library paths and common package
  manager/systemd/dbus state. Homes, arbitrary `/opt` applications and service databases are not
  part of this preset. Add them with a custom scope or choose the full scope.
- **Full system and data:** the root filesystem plus detected eligible internal filesystems,
  including user homes and application data, subject to the listed exclusions.
- **Selected directories:** explicit absolute Linux paths. Overlapping roots, path traversal,
  virtual runtime paths and backup repositories are refused. Symlinked parent directories are rejected. A selected leaf symlink is stored as a
  symlink; Borg does not follow it to silently capture another directory.

`/proc`, `/sys`, `/dev`, `/run`, `/tmp`, `/var/tmp`, backup destinations, virtual filesystems,
bind duplicates and unselected external/network mounts are excluded. Full scope adds supported
internal filesystem mounts explicitly with `--one-file-system`; `/mnt`, `/media`, Docker layer
mounts and snap mounts are not automatically traversed. Select an external directory explicitly
when it is intentional. Inspect the preview for unusual mount/subvolume layouts. User exclusions
are literal path prefixes, not shell/glob expressions. Cache exclusions are optional.

This is a **live file copy**, not an atomic filesystem or application snapshot. EveryOS never
stops an existing service/container to take it. Open databases or simultaneously changing data
may be inconsistent; arrange application-aware dumps/quiescence separately. Use the EveryOS
backup tab for a consistent SQLite backup. Borg exit status 1 produces a visible **incomplete
or warning** result; it is never called a complete successful backup. A later successful checksum
verification cannot turn omitted capture data into a complete backup.

Borg preserves file data, numeric ownership, permissions, timestamps, links and supported Linux
ACLs/xattrs. Sparse extraction skips zero chunks (allocation depends on chunk boundaries and the
restore filesystem). Destination filesystem support still matters. Details:
[Borg create](https://borgbackup.readthedocs.io/en/stable/usage/create.html),
[Borg extract](https://borgbackup.readthedocs.io/en/stable/usage/extract.html).

## Encryption and credentials

Choose encrypted (`repokey-blake2`) or explicitly consent to unencrypted (`none`) storage.
Target and encryption cannot be changed for an existing plan; use a new plan/repository.
Keep the encrypted repository **and its passphrase** safe. Losing the passphrase makes recovery
impossible. Unencrypted repositories expose captured credentials and do not provide equivalent
tamper protection.

The API seals scheduled-run passphrases using `SecretBox` with a plan-specific context. They
never appear in plan/task/history responses, URLs or audit events. The agent passes them to
Borg on an anonymous FD 3, not command arguments or environment variables. Detailed scope and
exclusions are stored in the archive comment (encrypted along with archive metadata when using
an encrypted repository). A private sidecar stores only scope category and verification state.
Original paths are not streamed into progress logs. Keep the EveryOS database/key material and
backup passphrase separately protected according to your recovery needs.

## Scheduling and retention

Choose manual, hourly, daily, weekly or monthly. The UI displays the server's timezone; monthly
days are restricted to 1–28 so the selected date exists every month. Native `backup.linux` tasks
appear in **Tasks**, with the same run history, pause/resume and failure notifications as other
tasks. Tasks recheck the current owner's permission at execution time. They require the owner's
linked Linux account and an **account-scoped sudo grant**; a session-only unlock is insufficient
for unattended work. Configure this deliberately under **Settings → Linux account**. Passwords
are never stored to bypass sudo. If the grant expires/revokes, the task fails visibly rather than
running with someone else's authority. Cancelling the job remains possible after grant expiry.

One Linux operation runs at a time. Closing the browser does not cancel it. Completion is polled
and persisted by the API; history is bounded to the most recent 100 jobs. An agent restart marks
an interrupted job as failed instead of inventing a successful result. The repository remains
available for subsequent integrity checking.

Retention is **off by default**. Enabling it explicitly authorizes removing older EveryOS-named
archives from that plan's dedicated repository, with hourly/daily/weekly/monthly rules and at
least the latest archive kept. It runs only after a successful, data-verified capture, or through
a separate password-confirmed retention action. Unrelated archive names are not selected.
[Borg prune](https://borgbackup.readthedocs.io/en/stable/usage/prune.html) determines period
buckets. Compaction reclaims storage after pruning. The UI lists the latest 1000 archives;
older retained archives remain in the repository.

## Delete a selected backup

Each archive row has **Delete backup**. The confirmation identifies the plan and exact archive,
warns that deletion is permanent (including the last remaining copy), and requires the account
password again. Both API and agent contracts require explicit confirmation and a canonical
EveryOS archive name; the operation never falls back to deleting the repository. Administrator
backup permission, Linux sudo policy, target identity and private repository markers remain
mandatory. Start and completion are audited without secrets.

A background job deletes that one archive and compacts unused repository space. Other archives,
source files and previously extracted recovery directories are preserved. A partial cleanup or
interrupted deletion is reported honestly as a warning; refreshing the archive list shows the
actual state. Cancellation cannot restore an archive already deleted. See
[Borg delete](https://borgbackup.readthedocs.io/en/stable/usage/delete.html).

Refresh shows an animated icon until the overview and expanded archive list finish loading.
After a stop request is accepted, its spinner remains visible until the running job reaches a
terminal state. A failed stop request clears the spinner and permits retry.

## Verification and recovery

Every successful capture is followed by an archive/data integrity check. Individual archive
verification can be rerun from the screen. Verification state is shown per archive and does
not assert application consistency.

**Extract to recovery directory** requires administrator account-password confirmation. The
agent validates the archive, runs an extraction dry run, then extracts with numeric IDs and
sparse support into a newly created private directory:

```text
<destination>/everyos-linux-<plan-id>/restores/<job-id>/
```

The UI shows the actual completed path. Existing source files and the running root filesystem
are never overwritten. Failed/cancelled extraction may leave partial files in that private
job directory; they are not presented as completed recovery and are not deleted automatically.
Inspect/remove those directories deliberately when no longer needed.

A file-based full system recovery requires an offline rescue environment: provision/mount the
new filesystems, unlock the repository using the retained passphrase, extract/check the files,
review mount configuration and reinstall the bootloader as appropriate for that host. EveryOS
does not create a bootable disk image, partition table, EFI variables or rescue medium. No live
root overwrite is provided by this screen. Standard Borg tools can read these repositories;
see [Borg recovery guidance](https://borgbackup.readthedocs.io/en/stable/usage/extract.html).

## Development and validation

Normal development agents refuse host Linux backup operations. A fixture is enabled only with
`EVERYOS_ENV=development`, `EVERYOS_AGENT_SIMULATE=1`, an explicit `EVERYOS_DEV_ROOT` and
`EVERYOS_DEV_BORG_BINARY`. It reads only `<dev-root>/linux-backup-source` and writes only
`<dev-root>/linux-backup-target`; the UI marks it as simulated source data. The Borg operations
and recovered files are real. Do not point these variables at a real system tree.

Set `EVERYOS_TEST_BORG` to a trusted Borg 1.x executable to run native agent tests and the Linux
backup Playwright scenario. Linux CI installs Borg, `acl` and `attr` for real preservation tests.
No test needs to overwrite the runner's root, stop host services or change an owner's machine.
