# Disks

Settings › Disks lists the host's disks and lets an administrator mount extra and USB disks. A
plugged-in disk appears on the desktop and in Files at once; an administrator mounts it with one
click, and EveryOS can remember it so it mounts by itself whenever it is plugged in. EveryOS never
formats, partitions or repairs a disk, and it never touches the disk that holds the running
system.

## Plugging in a disk

The agent watches `/dev/disk/by-uuid` with inotify (`disks.watch`, a stream operation). udev adds
and removes a link there for every filesystem, so a burst of changes becomes one tick (700 ms
debounce), followed by checks after 2 and 6 seconds so a mount that systemd starts for a
remembered disk is seen too. A safety tick runs every minute, and every 5 seconds where the
directory cannot be watched. On each tick the API lists the disks again and, when the listing
changed, sends it to every open shell on the `disks` event topic (`system:read`).

What changes in the browser at once:

- **Desktop:** every plugged-in volume EveryOS can mount gets a drive icon in the right-most
  column, above files and shortcuts (they move aside for display; their saved places do not
  change). A dimmed icon is not mounted: double-click opens the mount dialog for administrators.
  A mounted one opens Files at the disk. Its menu offers Open or Mount, **Mount whenever plugged
  in**, **Eject safely** and the disk settings.
- **Files:** mounted disks are locations under **Disks**, with an eject button; plugged-in volumes
  that are not mounted are listed there too, with a mount button for administrators.
- **Pulse:** for five seconds the pill in the middle of the menu bar says **New disk connected**
  or **Disk removed** with the disk's name ([pulse.md](pulse.md)).
- **Menu bar storage item and dock shelf:** see [transfers.md](transfers.md#where-it-shows).
- **Notifications:** `disk-attached` (administrators) names the disk and says whether it was
  mounted by itself; `disk-detached` (everyone who sees the system) says a disk was removed, as a
  warning when it was still mounted and cached writes may be lost. Both pop up every time, whatever
  the minimum pop-up severity (turned-off pop-ups and a muted Storage category still apply), merge
  per disk within an hour in the list, and open Settings › Disks. Disks present when the API starts
  are not announced.

The mount dialog shows the disk's size and filesystem and has **Mount this disk by itself whenever
it is plugged in** checked by default.

## What is listed

The agent runs `lsblk --json --bytes` and shows every disk with its partitions: model, size,
transport (`usb`, `sata`, `nvme`, `mmc`…), filesystem, label and current mount points. Loop, zram,
RAM, optical and floppy devices are hidden.

A disk is a **system disk** when any partition, LVM volume or encrypted volume on it holds a system
mount: `/`, `/boot` and everything below it, `/usr`, `/var`, `/home`, `/opt`, `/etc`, `/root`,
`/tmp`, `/srv` or swap. System disks are listed for information only, collapsed, and have no
actions.

## Mounting

Only volumes with these filesystems can be mounted: ext2/3/4, btrfs, xfs, vfat, exFAT and NTFS
(through the kernel's `ntfs3` driver). A volume is named by its filesystem UUID and mounted at
`/srv/everyos/disks/<uuid>`. The agent refuses, with a reason the UI explains:

| Reason                   | When                                                     |
| ------------------------ | -------------------------------------------------------- |
| `system-disk`            | The disk holds a system mount.                           |
| `unsupported-filesystem` | Another filesystem, or none.                             |
| `mounted-elsewhere`      | The volume is already mounted outside EveryOS's root.    |
| `not-found`              | No volume has this UUID (unplugged, or a malformed one). |
| `busy`                   | Unmounting failed because something still uses the disk. |
| `mount-failed`           | systemd could not mount it; nothing is left behind.      |

Mounting goes through systemd, so the mount belongs to the whole host and not only to the agent's
mount namespace. The agent writes a mount unit marked as managed by EveryOS:

- **Remembered** (mount whenever plugged in): `/etc/systemd/system/<unit>.mount` with
  `WantedBy=multi-user.target dev-disk-by\x2duuid-<uuid>.device`. systemd mounts the disk at every
  boot and whenever its device appears; when the device disappears, systemd releases the mount
  (mount units are bound to their device). `nofail` keeps the boot going without the disk.
- **This time only:** `/run/systemd/system/<unit>.mount`, which disappears at the next boot and is
  not mounted again when the disk is plugged in later.

Options are always `nodev,nosuid,noexec,noatime,nofail`. Changing only the remembered setting of
a mounted disk moves its unit between the two directories and keeps its options and owner. Units
written by EveryOS 0.1.27 (boot only) are upgraded to the device dependency when the agent first
lists the disks.

**Remembered disks that are not plugged in** are listed under Settings › Disks › Remembered disks
(`remembered` in the listing, with the label from the unit's description). **Forget** disables and
deletes the unit; nothing on the disk changes.

**Ownership.** Files run as the person's linked Linux account ([linux-accounts.md](linux-accounts.md)).
On ext, btrfs and xfs, the disk's own Unix permissions apply: a freshly created ext4 filesystem
belongs to root, so Files can read it but reports `LINUX_FILE_DENIED` when writing until the
owner changes permissions with `sudo chown`. FAT, exFAT and NTFS have no Unix permissions; like a
desktop automounter, EveryOS gives their files to the Linux account of the administrator who
mounted them (`uid=`, `gid=`) with `umask=0022`, so others may read.

## Removing a disk

**Eject safely** asks for confirmation and sends the UUID again (`confirm`). The agent stops the
unit, disables it, deletes it from both unit directories, reloads systemd and removes the empty
mount directory, so the disk is also forgotten. A disk pulled out without ejecting loses writes
that were still cached, which is why EveryOS warns about it. When something still holds the disk open (a shell, a container, a transfer),
systemd refuses and the disk stays mounted with the `busy` reason.

## Files

`/srv/everyos` and `/srv/everyos/disks` are `root:root 0755`, so Linux accounts can reach the
disks. In production, the account worker lists the volumes mounted below the root from
`/proc/self/mountinfo` (no command, no privileges) and names them by label from
`/dev/disk/by-label`, else by UUID. Each appears as a Files location of kind `disk` with id
`disk-<uuid>` (lower case, at most 32 characters) and is read-only when mounted read-only.

Files keeps a free-space reserve (`files.minFreeMiB`) so uploads cannot fill the system's
filesystem. The reserve does not apply inside a disk location: an added disk may be filled up.

In development the API's own Files view lists disks from the agent's (simulated) listing.

## Permissions

| Action                 | Who                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| List and watch disks   | `system:read`. Public host information in the agent; no Linux account needed.              |
| Mount, change, unmount | `system:manage`, plus a linked Linux account with sudo authorized (`LINUX_SUDO_REQUIRED`). |
| Browse a mounted disk  | `files:read`, as the linked Linux account.                                                 |

Every mount and unmount is audited (`disks.mount`, `disks.unmount`) with the UUID, the startup
setting and, on failure, the reason. In development the agent never mounts real disks: it uses a
simulator (a system card and a USB disk with ext4 and exFAT volumes) unless `lsblk` is available,
and then it only lists. The simulator also has a USB stick (`KINGSTON`, exFAT) that is plugged in
while the file `<dev root>/disks/.simulated-usb-stick` exists; the browser tests plug and unplug
it that way.

## API

| Method & path                | Permission      | Description                                                                                                                                  |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /system/disks`          | `system:read`   | `{ source, mountRoot, disks, remembered }`: volumes with mount state and the remembered flag, plus remembered disks that are not plugged in. |
| `POST /system/disks/mount`   | `system:manage` | `{ uuid, persistent }`: mount (`persistent` remembers it), or change only that setting.                                                      |
| `POST /system/disks/unmount` | `system:manage` | `{ uuid, confirm }` with `confirm` equal to `uuid`: eject and forget, or forget a remembered disk that is not plugged in.                    |
| `GET /events?topics=disks`   | `system:read`   | `disks.change` with the whole listing whenever it changes.                                                                                   |

Refusals are `409 CONFLICT` with `details.reason` from the table above.
