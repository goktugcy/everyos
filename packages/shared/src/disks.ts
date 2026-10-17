/*
 * Disks the administrator can mount (docs/disks.md). EveryOS mounts only filesystems on disks
 * that hold no system mount, always under its own mount root, and names them by filesystem
 * UUID; the system disk is listed for information and never changed.
 */

/** Where EveryOS mounts disks in production; each disk gets `<root>/<filesystem UUID>`. */
export const DISK_MOUNT_ROOT = "/srv/everyos/disks";

/** Filesystems EveryOS mounts (as reported by `lsblk`). */
export const MOUNTABLE_FILESYSTEMS = [
  "ext4",
  "ext3",
  "ext2",
  "btrfs",
  "xfs",
  "vfat",
  "exfat",
  "ntfs",
] as const;
export type MountableFilesystem = (typeof MOUNTABLE_FILESYSTEMS)[number];

/** Filesystem UUIDs as `lsblk` prints them (ext4/btrfs UUIDs, FAT/exFAT serials, NTFS ids). */
export const DISK_UUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;

/** The Files location of a mounted disk (Files ids allow 32 characters). */
export function diskRootId(uuid: string): string {
  return `disk-${uuid
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 27)}`;
}

export interface DiskVolume {
  /** Filesystem UUID; null when the volume has no filesystem EveryOS can name. */
  uuid: string | null;
  /** Kernel name, e.g. `sda1`. */
  name: string;
  sizeBytes: number;
  fsType: string | null;
  label: string | null;
  mountpoints: string[];
  /** Mounted by EveryOS under its mount root. */
  managed: boolean;
  /** EveryOS mounts it again when the host starts. */
  persistent: boolean;
  /** The filesystem is one EveryOS can mount. */
  supported: boolean;
  readOnly: boolean;
}

export interface DiskDevice {
  name: string;
  model: string | null;
  sizeBytes: number;
  /** `usb`, `sata`, `nvme`, `mmc`… as reported by the kernel. */
  transport: string | null;
  removable: boolean;
  /** Holds a system mount (/, /boot, swap, EveryOS data…); never mounted or unmounted. */
  system: boolean;
  volumes: DiskVolume[];
}

export interface DiskList {
  source: "host" | "simulated";
  mountRoot: string;
  disks: DiskDevice[];
}

/** Why a volume cannot be mounted, as the API reports it. */
export const DISK_REFUSALS = [
  "system-disk",
  "unsupported-filesystem",
  "mounted-elsewhere",
  "not-found",
  "busy",
  "mount-failed",
] as const;
export type DiskRefusal = (typeof DISK_REFUSALS)[number];
