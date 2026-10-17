import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diskRootId, type DiskList, type FileRootsResponse } from "@everyos/shared";
import { SIMULATED_STICK_MARKER } from "@everyos/system";
import { describe, expect, it } from "vitest";
import { completeSetup, createTestContext, json, TestClient, withRoles } from "./test-support.ts";

const USB = "2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24";
const SYSTEM_BOOT = "B3D1-5A2F";

describe("disks", () => {
  it("lists disks for everyone who sees the system and lets only administrators mount them", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    const listed = await json<DiskList>(await viewer.get("/api/system/disks"));
    expect(listed.disks.map((disk) => [disk.name, disk.system])).toEqual([
      ["mmcblk0", true],
      ["sda", false],
    ]);
    expect(
      (await operator.post("/api/system/disks/mount", { uuid: USB, persistent: true })).status,
    ).toBe(403);
    expect(
      (await admin.post("/api/system/disks/mount", { uuid: "../../etc", persistent: true })).status,
    ).toBe(400);
    const refused = await admin.post("/api/system/disks/mount", {
      uuid: SYSTEM_BOOT,
      persistent: false,
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("system-disk");

    const mounted = await json<DiskList>(
      await admin.post("/api/system/disks/mount", { uuid: USB, persistent: true }),
    );
    expect(mounted.disks[1]!.volumes[0]).toMatchObject({ managed: true, persistent: true });
    // Files offers the mounted disk as a location to everyone with file access.
    const roots = await json<FileRootsResponse>(await operator.get("/api/files/roots"));
    expect(roots.roots.find((root) => root.kind === "disk")).toMatchObject({
      id: diskRootId(USB),
      name: "Yedek",
      available: true,
    });
    expect((await operator.get(`/api/files/list?root=${diskRootId(USB)}&path=`)).status).toBe(200);

    expect(
      (await admin.post("/api/system/disks/unmount", { uuid: USB, confirm: "A1B2-C3D4" })).status,
    ).toBe(422);
    const ejected = await json<DiskList>(
      await admin.post("/api/system/disks/unmount", { uuid: USB, confirm: USB }),
    );
    expect(ejected.disks[1]!.volumes[0]).toMatchObject({ managed: false, persistent: false });
    expect(
      (await json<FileRootsResponse>(await operator.get("/api/files/roots"))).roots.some(
        (root) => root.kind === "disk",
      ),
    ).toBe(false);
    const audit = ctx.db.all<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_events WHERE action LIKE 'disks.%' ORDER BY rowid",
    );
    expect(audit).toEqual([
      { action: "disks.mount", outcome: "failure" },
      { action: "disks.mount", outcome: "success" },
      { action: "disks.unmount", outcome: "success" },
    ]);
  });

  it("keeps the system's free-space reserve off added disks", async () => {
    const ctx = await createTestContext({
      configure: (config) => {
        config.files.minFreeBytes = Number.MAX_SAFE_INTEGER;
      },
    });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    await admin.post("/api/system/disks/mount", { uuid: USB, persistent: false });
    const write = (root: string) =>
      admin.request("PUT", "/api/files/text", {
        body: { root, path: "note.txt", content: "kept\n", etag: null },
      });
    expect((await write(diskRootId(USB))).status).toBe(200);
    expect((await write("home")).status).toBe(507);
  });

  it("follows plugged-in disks live, announces them and mounts remembered ones by themselves", async () => {
    const { ctx, admin } = await withRoles();
    const disks = ctx.services.disks;
    const seen: DiskList[] = [];
    const unsubscribe = disks.subscribe((list) => seen.push(list));
    // Disk notices pop up every time, even when they merge into an earlier one.
    const popups: string[] = [];
    const stopPopups = ctx.services.notifications.subscribe((change) => {
      if (change.type === "changed" && change.toast) popups.push(change.notification.kind);
    });
    disks.start();
    try {
      const until = async (check: (list: DiskList) => boolean) => {
        for (let i = 0; i < 100; i++) {
          if (seen.length && check(seen.at(-1)!)) return seen.at(-1)!;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("No matching disk listing");
      };
      const stick = (list: DiskList) =>
        list.disks.find((disk) => disk.name === "sdb")?.volumes[0] ?? null;
      const root = (await until(() => true)).mountRoot;
      const notices = () =>
        ctx.db.all<{ kind: string; params: string }>(
          "SELECT kind, params FROM notifications WHERE kind LIKE 'disk-%' ORDER BY rowid",
        );
      expect(notices()).toEqual([]);

      writeFileSync(join(root, SIMULATED_STICK_MARKER), "");
      expect(stick(await until((list) => stick(list) !== null))).toMatchObject({
        label: "KINGSTON",
        managed: false,
      });
      expect(notices()).toHaveLength(1);
      expect(JSON.parse(notices()[0]!.params)).toMatchObject({ disk: "KINGSTON", mounted: "no" });

      await admin.post("/api/system/disks/mount", { uuid: "5E6F-7A8B", persistent: true });
      rmSync(join(root, SIMULATED_STICK_MARKER));
      expect(
        (await until((list) => stick(list) === null)).remembered.map((disk) => disk.uuid),
      ).toEqual(["5E6F-7A8B"]);
      // Pulled out while mounted: a warning.
      expect(notices().map((notice) => notice.kind)).toEqual(["disk-attached", "disk-detached"]);
      const detached = () =>
        ctx.db.get<{ count: number; severity: string; params: string }>(
          "SELECT count, severity, params FROM notifications WHERE kind = 'disk-detached'",
        )!;
      expect(detached()).toMatchObject({ severity: "warning" });
      expect(JSON.parse(detached().params)).toMatchObject({ unsafe: "yes" });

      writeFileSync(join(root, SIMULATED_STICK_MARKER), "");
      expect(stick(await until((list) => stick(list)?.managed === true))).toMatchObject({
        persistent: true,
      });
      // The same disk within the hour merges into its earlier notification.
      expect(
        ctx.db.get<{ count: number; params: string }>(
          "SELECT count, params FROM notifications WHERE kind = 'disk-attached'",
        ),
      ).toMatchObject({ count: 2 });

      // Ejected first, then unplugged: an ordinary notice, which replaces the earlier warning.
      await admin.post("/api/system/disks/unmount", { uuid: "5E6F-7A8B", confirm: "5E6F-7A8B" });
      rmSync(join(root, SIMULATED_STICK_MARKER));
      await until((list) => stick(list) === null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(detached()).toMatchObject({ count: 2, severity: "info" });
      expect(JSON.parse(detached().params)).toMatchObject({ unsafe: "no" });
      expect(popups).toEqual(["disk-attached", "disk-detached", "disk-attached", "disk-detached"]);
    } finally {
      stopPopups();
      unsubscribe();
      disks.stop();
    }
  });
});
