# Disks

Settings › Disks lists the host's disks and lets an administrator mount extra and USB disks. A
mounted disk appears in Files under **Disks**. EveryOS never formats, partitions or repairs a disk,
and it never touches the disk that holds the running system.

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

- **Mount at startup** on: `/etc/systemd/system/<unit>.mount`, enabled for
  `multi-user.target`. The disk is mounted again at every boot; `nofail` keeps the boot going when
  it is unplugged.
- **Mount at startup** off: `/run/systemd/system/<unit>.mount`, which disappears at the next boot.

Options are always `nodev,nosuid,noexec,noatime,nofail`. Changing only the startup setting of a
mounted disk moves its unit between the two directories and keeps its options.

**Ownership.** Files run as the person's linked Linux account ([linux-accounts.md](linux-accounts.md)).
On ext, btrfs and xfs, the disk's own Unix permissions apply: a freshly created ext4 filesystem
belongs to root, so Files can read it but reports `LINUX_FILE_DENIED` when writing until the
owner changes permissions with `sudo chown`. FAT, exFAT and NTFS have no Unix permissions; like a
desktop automounter, EveryOS gives their files to the Linux account of the administrator who
mounted them (`uid=`, `gid=`) with `umask=0022`, so others may read.

## Removing a disk

**Safely remove** asks for confirmation and sends the UUID again (`confirm`). The agent stops the
unit, disables it, deletes it from both unit directories, reloads systemd and removes the empty
mount directory. When something still holds the disk open (a shell, a container, a transfer),
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
| List disks             | `system:read`. Public host information in the agent; no Linux account needed.              |
| Mount, change, unmount | `system:manage`, plus a linked Linux account with sudo authorized (`LINUX_SUDO_REQUIRED`). |
| Browse a mounted disk  | `files:read`, as the linked Linux account.                                                 |

Every mount and unmount is audited (`disks.mount`, `disks.unmount`) with the UUID, the startup
setting and, on failure, the reason. In development the agent never mounts real disks: it uses a
simulator (a system card and a USB disk with ext4 and exFAT volumes) unless `lsblk` is available,
and then it only lists.

## API

| Method & path                | Permission      | Description                                                                |
| ---------------------------- | --------------- | -------------------------------------------------------------------------- |
| `GET /system/disks`          | `system:read`   | `{ source, mountRoot, disks }` with volumes, mount state and startup flag. |
| `POST /system/disks/mount`   | `system:manage` | `{ uuid, persistent }`: mount, or change only the startup setting.         |
| `POST /system/disks/unmount` | `system:manage` | `{ uuid, confirm }` with `confirm` equal to `uuid`.                        |

Refusals are `409 CONFLICT` with `details.reason` from the table above.
