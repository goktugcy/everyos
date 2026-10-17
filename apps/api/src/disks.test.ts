import { diskRootId, type DiskList, type FileRootsResponse } from "@everyos/shared";
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
});
