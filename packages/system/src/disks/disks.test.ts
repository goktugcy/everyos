import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskListSchema } from "@everyos/shared/schemas";
import { describe, expect, it } from "vitest";
import {
  createDiskSimulator,
  escapeUnitPath,
  isSystemMount,
  parseLsblk,
  readMountedDisks,
} from "./disks.ts";

// Shaped like util-linux 2.39 `lsblk --json --bytes` on a Raspberry Pi with a USB disk.
const pi = {
  blockdevices: [
    {
      name: "loop0",
      type: "loop",
      size: 4096,
      fstype: "squashfs",
      mountpoints: ["/snap/core/1"],
    },
    {
      name: "mmcblk0",
      type: "disk",
      size: 63864569856,
      model: null,
      tran: null,
      rm: false,
      hotplug: false,
      ro: false,
      mountpoints: [null],
      children: [
        {
          name: "mmcblk0p1",
          type: "part",
          size: 536870912,
          fstype: "vfat",
          label: "system-boot",
          uuid: "B3D1-5A2F",
          mountpoints: ["/boot/firmware"],
          ro: false,
        },
        {
          name: "mmcblk0p2",
          type: "part",
          size: 63327698944,
          fstype: "ext4",
          label: "writable",
          uuid: "9c2e7f41-63a8-4b0e-8d5c-1f7a2b3c4d5e",
          mountpoints: ["/"],
          ro: false,
        },
      ],
    },
    {
      name: "sda",
      type: "disk",
      size: 1000204886016,
      model: "Portable SSD",
      tran: "usb",
      rm: "1",
      hotplug: true,
      ro: false,
      mountpoints: [null],
      children: [
        {
          name: "sda1",
          type: "part",
          size: 900000000000,
          fstype: "ext4",
          label: "Yedek",
          uuid: "2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24",
          mountpoints: ["/srv/everyos/disks/2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24"],
          ro: false,
        },
        {
          name: "sda2",
          type: "part",
          size: 100204886016,
          fstype: "exfat",
          label: "PHOTOS",
          uuid: "A1B2-C3D4",
          mountpoints: ["/media/owner/PHOTOS"],
          ro: false,
        },
        {
          name: "sda3",
          type: "part",
          size: 1048576,
          fstype: "crypto_LUKS",
          uuid: "6d1c0a4e-0000-4000-8000-000000000001",
          mountpoints: [null],
        },
      ],
    },
    {
      name: "nvme0n1",
      type: "disk",
      size: 512110190592,
      model: "NVMe SSD",
      tran: "nvme",
      rm: false,
      children: [
        {
          name: "nvme0n1p1",
          type: "part",
          size: 512110190592,
          fstype: "LVM2_member",
          children: [
            {
              name: "vg-docker",
              type: "lvm",
              fstype: "ext4",
              uuid: "11111111-2222-4333-8444-555555555555",
              mountpoints: ["/var/lib/docker"],
            },
          ],
        },
      ],
    },
    {
      name: "sdb",
      type: "disk",
      size: 32010928128,
      model: "Flash Disk",
      tran: "usb",
      rm: true,
      fstype: "vfat",
      label: "STICK",
      uuid: "1234-ABCD",
      mountpoints: [null],
    },
  ],
};

describe("disk listing", () => {
  it("marks every disk with a system mount and offers only supported volumes", () => {
    const disks = parseLsblk(pi, {
      mountRoot: "/srv/everyos/disks",
      persistent: new Set(["2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24"]),
    });
    DiskListSchema.parse({ source: "host", mountRoot: "/srv/everyos/disks", disks });
    expect(disks.map((disk) => [disk.name, disk.system, disk.removable])).toEqual([
      ["mmcblk0", true, false],
      ["sda", false, true],
      // Docker's data on LVM makes the NVMe disk part of the system too.
      ["nvme0n1", true, false],
      ["sdb", false, true],
    ]);
    const sda = disks[1]!.volumes;
    expect(sda.map((v) => [v.name, v.managed, v.persistent, v.supported])).toEqual([
      ["sda1", true, true, true],
      ["sda2", false, false, true],
      ["sda3", false, false, false],
    ]);
    expect(sda[1]!.mountpoints).toEqual(["/media/owner/PHOTOS"]);
    // A stick formatted without a partition table is its own volume.
    expect(disks[3]!.volumes).toEqual([
      expect.objectContaining({ name: "sdb", uuid: "1234-ABCD", fsType: "vfat", label: "STICK" }),
    ]);
  });

  it("knows the system mounts and escapes unit names like systemd", () => {
    for (const path of ["/", "/boot/firmware", "/var/lib/docker", "[SWAP]", "/home", "/srv"])
      expect(isSystemMount(path), path).toBe(true);
    for (const path of ["/srv/everyos/disks/x", "/media/owner/PHOTOS", "/mnt/data"])
      expect(isSystemMount(path), path).toBe(false);
    expect(escapeUnitPath("/srv/everyos/disks/2f6a3c1e-8b4d")).toBe(
      "srv-everyos-disks-2f6a3c1e\\x2d8b4d",
    );
    expect(escapeUnitPath("/srv/everyos/disks/A1B2-C3D4")).toBe("srv-everyos-disks-A1B2\\x2dC3D4");
    expect(escapeUnitPath("/mnt/.hidden dir/")).toBe("mnt-.hidden\\x20dir");
  });

  it("simulates mounting without touching the host's system disk", async () => {
    const disks = createDiskSimulator({ mountRoot: "/tmp/everyos-sim-disks" });
    await expect(disks.mount("B3D1-5A2F", true, null)).rejects.toMatchObject({
      kind: "system-disk",
    });
    const mounted = await disks.mount("A1B2-C3D4", true, { uid: 1000, gid: 1000 });
    expect(mounted.disks[1]!.volumes[1]).toMatchObject({ managed: true, persistent: true });
    const unmounted = await disks.unmount("A1B2-C3D4");
    expect(unmounted.disks[1]!.volumes[1]).toMatchObject({ managed: false, persistent: false });
  });

  it("finds the mounted disks from the mount table without privileges", () => {
    const root = mkdtempSync(join(tmpdir(), "everyos-mounted-disks-"));
    try {
      const dev = join(root, "dev");
      for (const dir of ["by-uuid", "by-label"]) mkdirSync(join(dev, dir), { recursive: true });
      for (const device of ["sda1", "sda2"]) writeFileSync(join(root, device), "");
      symlinkSync(join(root, "sda1"), join(dev, "by-uuid", "2f6a3c1e-8b4d"));
      symlinkSync(join(root, "sda2"), join(dev, "by-uuid", "A1B2-C3D4"));
      symlinkSync(join(root, "sda2"), join(dev, "by-label", "My\\x20Photos"));
      const mountinfo = join(root, "mountinfo");
      writeFileSync(
        mountinfo,
        [
          "29 1 179:2 / / rw,noatime shared:1 - ext4 /dev/mmcblk0p2 rw",
          "90 29 8:1 / /srv/everyos/disks/2f6a3c1e-8b4d ro,nosuid,nodev,noexec shared:50 - ext4 /dev/sda1 ro",
          "91 29 8:2 / /srv/everyos/disks/A1B2-C3D4 rw,nosuid shared:51 - exfat /dev/sda2 rw,uid=1000",
          "92 29 8:3 / /srv/everyos/disks/x/../../etc rw shared:52 - ext4 /dev/sda3 rw",
          "93 29 8:4 / /media/owner/USB\\040STICK rw shared:53 - vfat /dev/sdb1 rw",
          "",
        ].join("\n"),
      );
      expect(
        readMountedDisks({ mountRoot: "/srv/everyos/disks/", mountinfo, devDir: dev }),
      ).toEqual([
        {
          uuid: "2f6a3c1e-8b4d",
          path: "/srv/everyos/disks/2f6a3c1e-8b4d",
          label: null,
          readOnly: true,
        },
        {
          uuid: "A1B2-C3D4",
          path: "/srv/everyos/disks/A1B2-C3D4",
          label: "My Photos",
          readOnly: false,
        },
      ]);
      expect(
        readMountedDisks({ mountRoot: "/srv/everyos/disks", mountinfo: join(root, "none") }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
