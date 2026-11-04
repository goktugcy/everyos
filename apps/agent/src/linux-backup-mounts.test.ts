import { describe, expect, it } from "vitest";
import { backupMounts, backupMountSelection } from "./linux-backup-mounts.ts";

const mounts = backupMounts(
  [
    "1 0 8:1 / / rw - ext4 /dev/root rw",
    "2 1 8:2 / /home rw - ext4 /dev/home rw",
    "3 1 8:3 / /boot rw - ext4 /dev/boot rw",
    "4 3 8:4 / /boot/efi rw - vfat /dev/efi rw",
    "5 1 8:1 / /srv/recursive-bind rw - ext4 /dev/root rw",
    "6 1 0:42 / /home-network rw - nfs server:/home rw",
    "7 1 8:5 / /mnt/External\\040Disk rw - ext4 /dev/disk rw",
    "8 1 0:11 / /proc rw - proc proc rw",
  ].join("\n"),
);
describe("Linux backup mount selection", () => {
  it("captures independent home/boot/EFI filesystems but excludes bind loops, virtual and external mounts", () => {
    const result = backupMountSelection(mounts, ["/"], true, ["/proc"]);
    expect(result.paths).toEqual(["/", "/home", "/boot", "/boot/efi"]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        "/srv/recursive-bind",
        "/home-network",
        "/mnt/External Disk",
        "/proc",
      ]),
    );
  });
  it("allows an explicitly selected external source without following nested binds", () => {
    const result = backupMountSelection(mounts, ["/mnt/External Disk/documents"], false, ["/proc"]);
    expect(result.paths).toEqual(["/mnt/External Disk/documents"]);
    expect(result.excluded).not.toContain("/mnt/External Disk");
  });
  it("honors exclusions even when a directory is a separate filesystem", () => {
    expect(backupMountSelection(mounts, ["/"], true, ["/home", "/boot"]).paths).toEqual(["/"]);
  });
  it("includes distinct btrfs subvolumes without following binds of the same subvolume", () => {
    const btrfs = backupMounts(
      [
        "1 0 0:32 /@ / rw - btrfs /dev/sda2 rw,subvolid=256,subvol=/@",
        "2 1 0:32 /@home /home rw - btrfs /dev/sda2 rw,subvolid=257,subvol=/@home",
        "3 1 0:32 /@ /srv/loop rw - btrfs /dev/sda2 rw,subvolid=256,subvol=/@",
      ].join("\n"),
    );
    const result = backupMountSelection(btrfs, ["/"], true, []);
    expect(result.paths).toEqual(["/", "/home"]);
    expect(result.excluded).toContain("/srv/loop");
  });
});
