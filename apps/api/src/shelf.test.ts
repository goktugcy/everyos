import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  SHELF_DIRECTORY,
  type FileSearchResult,
  type PulsePreferences,
  type ShelfTidyResponse,
  type TrashListing,
} from "@everyos/shared";
import { describe, expect, it, vi } from "vitest";
import { SHELF_ORPHAN_AGE_MS } from "./modules/files/file-service.ts";
import { createTestContext, completeSetup, json, TestClient } from "./test-support.ts";

const shelfPath = (name: string) => `${SHELF_DIRECTORY}/${name}`;
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** An administrator with a home that has the shelf's folder. */
async function setup() {
  const ctx = await createTestContext();
  await ctx.services.files.ensureRoots();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  const id = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
  expect(
    (await admin.post("/api/files/mkdir", { root: "home", path: "", name: SHELF_DIRECTORY }))
      .status,
  ).toBe(201);
  const home = join(ctx.config.files.homesDir!, id);
  return { ctx, admin, home, shelf: join(home, SHELF_DIRECTORY) };
}

/** Makes a file look `ms` older than the server's clock. */
function age(path: string, now: number, ms: number) {
  const seconds = (now - ms) / 1000;
  utimesSync(path, seconds, seconds);
}

describe("pulse shelf files", () => {
  it("deletes shelf files for good, never through the trash, and refuses anything else", async () => {
    const { admin, home, shelf } = await setup();
    writeFileSync(join(shelf, "dropped.txt"), "dropped");
    writeFileSync(join(home, "keep.txt"), "keep");
    // A link on the shelf goes itself; what it points to stays.
    symlinkSync(join(home, "keep.txt"), join(shelf, "link.txt"));
    expect(
      (
        await admin.post("/api/files/shelf/discard", {
          paths: [shelfPath("dropped.txt"), shelfPath("link.txt"), shelfPath("gone.txt")],
        })
      ).status,
    ).toBe(204);
    expect(readdirSync(shelf)).toEqual([]);
    expect(readFileSync(join(home, "keep.txt"), "utf8")).toBe("keep");
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toEqual([]);

    for (const path of [
      "keep.txt",
      `${SHELF_DIRECTORY}/../keep.txt`,
      `${SHELF_DIRECTORY}/..`,
      `${SHELF_DIRECTORY}/folder/keep.txt`,
      SHELF_DIRECTORY,
    ])
      expect((await admin.post("/api/files/shelf/discard", { paths: [path] })).status, path).toBe(
        400,
      );
    expect(existsSync(join(home, "keep.txt"))).toBe(true);
  });

  it("never follows a shelf folder that was replaced by a link", async () => {
    const { admin, home, shelf } = await setup();
    rmSync(shelf, { recursive: true });
    mkdirSync(join(home, "precious"));
    writeFileSync(join(home, "precious", "doc.txt"), "doc");
    symlinkSync(join(home, "precious"), shelf);
    expect(
      (await admin.post("/api/files/shelf/discard", { paths: [shelfPath("doc.txt")] })).status,
    ).toBe(400);
    expect((await admin.post("/api/files/shelf/tidy", {})).status).toBe(400);
    expect(readFileSync(join(home, "precious", "doc.txt"), "utf8")).toBe("doc");
  });

  it("tidies files the stored shelf no longer lists once they are an hour old", async () => {
    const { ctx, admin, shelf } = await setup();
    const now = ctx.clock.now;
    for (const name of ["listed.txt", "orphan.txt", "fresh.txt"])
      writeFileSync(join(shelf, name), name);
    age(join(shelf, "listed.txt"), now, SHELF_ORPHAN_AGE_MS + 60_000);
    age(join(shelf, "orphan.txt"), now, SHELF_ORPHAN_AGE_MS + 60_000);
    age(join(shelf, "fresh.txt"), now, 60_000);
    const pulse: PulsePreferences = {
      version: 1,
      enabled: true,
      openOnHover: true,
      destination: null,
      shelf: [
        { root: "home", path: shelfPath("listed.txt"), kind: "file", size: 10, addedAt: now },
      ],
    };
    expect((await admin.request("PUT", "/api/preferences/pulse", { body: pulse })).status).toBe(
      204,
    );

    const tidy = await json<ShelfTidyResponse>(await admin.post("/api/files/shelf/tidy", {}));
    // Not saved to the shelf yet (another tab, an upload finishing) is not an orphan yet either.
    expect(tidy.paths).toEqual([shelfPath("fresh.txt"), shelfPath("listed.txt")]);
    expect(readdirSync(shelf).sort()).toEqual(["fresh.txt", "listed.txt"]);
    expect(
      ctx.db
        .all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'files.shelf%'")
        .map((row) => row.action),
    ).toEqual(["files.shelf.tidy"]);
    // Search never lists what waits on the shelf.
    const found = await json<FileSearchResult>(
      await admin.get(`/api/files/search?${q({ root: "home", path: "", q: "fresh" })}`),
    );
    expect(found.results).toEqual([]);

    rmSync(shelf, { recursive: true });
    expect(await json<ShelfTidyResponse>(await admin.post("/api/files/shelf/tidy", {}))).toEqual({
      paths: [],
    });
  });

  it("deletes a shelf file once it was downloaded whole for a drag out", async () => {
    const { admin, home, shelf } = await setup();
    writeFileSync(join(shelf, "out.txt"), "payload");
    writeFileSync(join(home, "kept.txt"), "kept");
    const download = (path: string, extra: Record<string, string> = {}) =>
      `/api/files/download?${q({ root: "home", path, ...extra })}`;

    // A partial read or a plain download leaves it on the shelf.
    const partial = await admin.request(
      "GET",
      download(shelfPath("out.txt"), { discard: "true" }),
      {
        headers: { range: "bytes=0-2" },
      },
    );
    expect(await partial.text()).toBe("pay");
    expect(await (await admin.get(download(shelfPath("out.txt")))).text()).toBe("payload");
    // Only shelf files are ever deleted this way.
    expect(await (await admin.get(download("kept.txt", { discard: "true" }))).text()).toBe("kept");
    expect(existsSync(join(shelf, "out.txt"))).toBe(true);

    expect(
      await (await admin.get(download(shelfPath("out.txt"), { discard: "true" }))).text(),
    ).toBe("payload");
    await vi.waitFor(() => expect(existsSync(join(shelf, "out.txt"))).toBe(false));
    expect(readFileSync(join(home, "kept.txt"), "utf8")).toBe("kept");
  });

  it("leaves no copy in the trash when a shelf file moves to a Linux location", async () => {
    const { ctx, admin, shelf } = await setup();
    writeFileSync(join(shelf, "photo.jpg"), "jpeg");
    ctx.services.config.mode = "production";
    const transferId = randomUUID();
    const received: string[] = [];
    ctx.agent.handlers.set("files.upload.open", () => ({ transferId }));
    ctx.agent.handlers.set("files.upload.write", (params) => {
      received.push(Buffer.from((params as { data: string }).data, "base64").toString());
      return null;
    });
    ctx.agent.handlers.set("files.upload.close", () => null);
    expect(
      (
        await admin.post("/api/files/move", {
          root: "home",
          paths: [shelfPath("photo.jpg")],
          destination: { root: "pictures", path: "" },
        })
      ).status,
    ).toBe(204);
    expect(received.join("")).toBe("jpeg");
    expect(existsSync(join(shelf, "photo.jpg"))).toBe(false);
    ctx.services.config.mode = "development";
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toEqual([]);
  });
});
