import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiErrorBody,
  FileListing,
  FileProperties,
  FileRootsResponse,
  FileSearchResult,
  TextFile,
  TrashListing,
} from "@everyos/shared";
import { describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.ts";
import {
  createTestContext,
  completeSetup,
  json,
  STRONG_PASSWORD,
  TestClient,
} from "./test-support.ts";

const code = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

async function setup(configure?: (config: ApiConfig) => void) {
  const ctx = await createTestContext(configure ? { configure } : {});
  await ctx.services.files.ensureRoots();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  for (const role of ["operator", "viewer"] as const)
    await admin.post("/api/users", {
      username: role,
      displayName: role,
      password: STRONG_PASSWORD,
      role,
      locale: "tr",
    });
  const viewer = new TestClient(ctx, "192.0.2.11");
  await viewer.login("viewer", STRONG_PASSWORD);
  const operator = new TestClient(ctx, "192.0.2.10");
  await operator.login("operator", STRONG_PASSWORD);
  const root = ctx.config.files.roots[0]?.path ?? "";
  return { ctx, admin, viewer, operator, root };
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

describe("private recoverable trash", () => {
  it("keeps whole folders and escaping links recoverable, without exposing trash through listing or search", async () => {
    const { admin, root } = await setup();
    mkdirSync(join(root, "report"));
    writeFileSync(join(root, "report", "notes.txt"), "recover me");
    const outside = mkdtempSync(join(tmpdir(), "everyos-trash-outside-"));
    writeFileSync(join(outside, "secret.txt"), "unchanged");
    symlinkSync(outside, join(root, "escape"));
    expect(
      (
        await admin.post("/api/files/delete", {
          root: "dev",
          paths: ["report/notes.txt", "report", "report", "escape"],
          confirm: true,
        })
      ).status,
    ).toBe(204);
    expect(existsSync(join(root, "report"))).toBe(false);
    const trash = await json<TrashListing>(await admin.get("/api/files/trash"));
    expect(trash.entries.map((entry) => entry.name).sort()).toEqual(["escape", "report"]);
    const hidden = await json<FileListing>(
      await admin.get("/api/files/list?root=dev&path=&hidden=true"),
    );
    expect(hidden.entries.map((entry) => entry.name)).not.toContain(".otuken-trash");
    const search = await json<FileSearchResult>(
      await admin.get("/api/files/search?root=dev&path=&q=notes"),
    );
    expect(search.results).toEqual([]);
    expect(
      (
        await admin.post("/api/files/trash/restore", {
          root: "dev",
          ids: trash.entries.map((entry) => entry.id),
        })
      ).status,
    ).toBe(204);
    expect(readFileSync(join(root, "report", "notes.txt"), "utf8")).toBe("recover me");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("unchanged");
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toEqual([]);
  });

  it("isolates users on shared roots and requires permission and explicit confirmation for permanent deletion", async () => {
    const { admin, operator, viewer, root, ctx } = await setup();
    writeFileSync(join(root, "private.txt"), "private trash");
    await admin.post("/api/files/delete", { root: "dev", paths: ["private.txt"], confirm: true });
    const item = (await json<TrashListing>(await admin.get("/api/files/trash"))).entries[0]!;
    expect((await json<TrashListing>(await operator.get("/api/files/trash"))).entries).toEqual([]);
    for (const endpoint of ["restore", "delete"]) {
      expect(
        (
          await operator.post(`/api/files/trash/${endpoint}`, {
            root: "dev",
            ids: [item.id],
            ...(endpoint === "delete" ? { confirm: true } : {}),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await viewer.post(`/api/files/trash/${endpoint}`, {
            root: "dev",
            ids: [item.id],
            confirm: true,
          })
        ).status,
      ).toBe(403);
    }
    expect((await viewer.get("/api/files/trash")).status).toBe(403);
    expect(
      (await admin.post("/api/files/trash/delete", { root: "dev", ids: [item.id] })).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/files/trash/delete", {
          root: "dev",
          ids: ["../outside"],
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await admin.post("/api/files/trash/delete", { root: "dev", ids: [item.id], confirm: true }))
        .status,
    ).toBe(204);
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toEqual([]);
    expect(
      ctx.db
        .all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'files.%'")
        .map((row) => row.action),
    ).toContain("files.trash.delete");
  });

  it("preserves both versions when the original name is occupied", async () => {
    const { admin, root } = await setup();
    writeFileSync(join(root, "same.txt"), "old");
    await admin.post("/api/files/delete", { root: "dev", paths: ["same.txt"], confirm: true });
    const item = (await json<TrashListing>(await admin.get("/api/files/trash"))).entries[0]!;
    writeFileSync(join(root, "same.txt"), "new");
    expect(
      (await admin.post("/api/files/trash/restore", { root: "dev", ids: [item.id] })).status,
    ).toBe(409);
    expect(readFileSync(join(root, "same.txt"), "utf8")).toBe("new");
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toHaveLength(1);
    unlinkSync(join(root, "same.txt"));
    expect(
      (await admin.post("/api/files/trash/restore", { root: "dev", ids: [item.id] })).status,
    ).toBe(204);
    expect(readFileSync(join(root, "same.txt"), "utf8")).toBe("old");
  });

  it("audits a restore that stops after a partial change", async () => {
    const { admin, root, ctx } = await setup();
    for (const name of ["first.txt", "second.txt"]) writeFileSync(join(root, name), name);
    await admin.post("/api/files/delete", {
      root: "dev",
      paths: ["first.txt", "second.txt"],
      confirm: true,
    });
    const items = (await json<TrashListing>(await admin.get("/api/files/trash"))).entries;
    const ids = ["first.txt", "second.txt"].map(
      (name) => items.find((item) => item.name === name)!.id,
    );
    writeFileSync(join(root, "second.txt"), "keep current version");
    expect((await admin.post("/api/files/trash/restore", { root: "dev", ids })).status).toBe(409);
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first.txt");
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("keep current version");
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toHaveLength(1);
    const events = ctx.db.all<{ details: string; outcome: string }>(
      "SELECT details, outcome FROM audit_events WHERE action = 'files.trash.restore'",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("failure");
    expect(JSON.parse(events[0]!.details)).toEqual({ ids, count: 2, succeeded: false });
  });

  it("never overwrites another version when two restores race for the same original name", async () => {
    const { admin, root } = await setup();
    for (const content of ["first", "second"]) {
      writeFileSync(join(root, "versions.txt"), content);
      expect(
        (
          await admin.post("/api/files/delete", {
            root: "dev",
            paths: ["versions.txt"],
            confirm: true,
          })
        ).status,
      ).toBe(204);
    }
    const entries = (await json<TrashListing>(await admin.get("/api/files/trash"))).entries;
    const results = await Promise.all(
      entries.map((entry) =>
        admin.post("/api/files/trash/restore", { root: "dev", ids: [entry.id] }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([204, 409]);
    expect(["first", "second"]).toContain(readFileSync(join(root, "versions.txt"), "utf8"));
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toHaveLength(1);
  });

  it("refuses direct trash access, symlink aliases and a symlinked trash directory", async () => {
    const { admin, root } = await setup();
    writeFileSync(join(root, "a.txt"), "a");
    await admin.post("/api/files/delete", { root: "dev", paths: ["a.txt"], confirm: true });
    symlinkSync(join(root, ".otuken-trash"), join(root, "alias"));
    for (const path of [".otuken-trash", "alias"])
      expect((await admin.get(`/api/files/list?${q({ root: "dev", path })}`)).status).toBe(404);
    expect(
      (await admin.post("/api/files/mkdir", { root: "dev", path: "", name: ".otuken-trash" }))
        .status,
    ).toBe(400);
    const second = await setup();
    const outside = mkdtempSync(join(tmpdir(), "everyos-trash-link-"));
    symlinkSync(outside, join(second.root, ".otuken-trash"));
    writeFileSync(join(second.root, "keep.txt"), "keep");
    expect(
      (
        await second.admin.post("/api/files/delete", {
          root: "dev",
          paths: ["keep.txt"],
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect(readFileSync(join(second.root, "keep.txt"), "utf8")).toBe("keep");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("drains pending file work and rejects new requests while homes are replaced", async () => {
    const { ctx, admin } = await setup();
    const id = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
    let finish: () => void = () => undefined;
    const pending = ctx.services.files.withAccess(
      id,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let replaced = false;
    const restore = ctx.services.files.withHomesLocked([id], () => {
      replaced = true;
      return Promise.resolve();
    });
    expect(replaced).toBe(false);
    expect((await admin.get("/api/files/roots")).status).toBe(409);
    finish();
    await Promise.all([pending, restore]);
    expect(replaced).toBe(true);
    expect((await admin.get("/api/files/roots")).status).toBe(200);
  });

  it("protects standard home folders through aliases and repairs unsafe folder names without escaping", async () => {
    const { ctx, admin } = await setup();
    const roots = await json<FileRootsResponse>(await admin.get("/api/files/roots"));
    const homeView = roots.roots.find((root) => root.kind === "home")!;
    const id = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
    const home = join(ctx.config.files.homesDir!, id);
    symlinkSync(home, join(home, "alias"));
    expect(
      (
        await admin.post("/api/files/delete", {
          root: "home",
          paths: [`alias/${homeView.folders!.desktop}`],
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.request("PUT", "/api/files/text", {
          body: { root: "home", path: ".otuken-folders.json", content: "{}", etag: null },
        })
      ).status,
    ).toBe(403);
    writeFileSync(
      join(home, ".otuken-folders.json"),
      JSON.stringify({ desktop: "../../escaped-directory", documents: "/tmp/escaped-directory" }),
    );
    const repaired = await json<FileRootsResponse>(await admin.get("/api/files/roots"));
    expect(repaired.roots[0]!.folders?.desktop).toBe("Masaüstü");
    expect(existsSync(join(ctx.config.files.homesDir!, "escaped-directory"))).toBe(false);
  });
});

describe("file manager", () => {
  it("lists only inside the root and never follows links out of it", async () => {
    const { admin, viewer, root } = await setup();
    const outside = mkdtempSync(join(tmpdir(), "everyos-outside-"));
    writeFileSync(join(outside, "secret.txt"), "outside");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.txt"), "hello");
    writeFileSync(join(root, ".hidden"), "x");
    symlinkSync(join(root, "docs"), join(root, "docs-link"));
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(root, "docs", "secret-link.txt"));

    expect((await viewer.get(`/api/files/roots`)).status).toBe(403);
    const roots = await json<FileRootsResponse>(await admin.get("/api/files/roots"));
    expect(roots.roots.map((r) => [r.id, r.kind])).toEqual([
      ["home", "home"],
      ["dev", "location"],
    ]);
    expect(roots.roots[1]).toEqual({
      id: "dev",
      name: "Development files",
      kind: "location",
      readOnly: false,
      available: true,
    });
    expect(roots.system).toEqual({ enabled: false, canManage: true });

    const listing = await json<FileListing>(
      await admin.get(`/api/files/list?${q({ root: "dev", path: "" })}`),
    );
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(["docs", "docs-link", "escape"]);
    expect(byName["docs-link"]!.link).toEqual({ type: "directory", inside: true });
    expect(byName.escape!.link).toEqual({ inside: false });
    const hidden = await json<FileListing>(
      await admin.get(`/api/files/list?${q({ root: "dev", path: "", hidden: "true" })}`),
    );
    expect(hidden.entries.some((e) => e.name === ".hidden")).toBe(true);

    // Following an inside link works; escaping links and traversal are refused.
    expect(
      (await admin.get(`/api/files/list?${q({ root: "dev", path: "docs-link" })}`)).status,
    ).toBe(200);
    const escape = await admin.get(`/api/files/list?${q({ root: "dev", path: "escape" })}`);
    expect(escape.status).toBe(404);
    expect(await code(escape)).toBe("NOT_FOUND");
    expect(
      (await admin.get(`/api/files/text?${q({ root: "dev", path: "docs/secret-link.txt" })}`))
        .status,
    ).toBe(404);
    expect(
      (await admin.get(`/api/files/download?${q({ root: "dev", path: "escape/secret.txt" })}`))
        .status,
    ).toBe(404);
    expect((await admin.get(`/api/files/list?${q({ root: "dev", path: "../" })}`)).status).toBe(
      400,
    );
    expect((await admin.get(`/api/files/list?${q({ root: "dev", path: "/etc" })}`)).status).toBe(
      400,
    );
    expect((await admin.get(`/api/files/list?${q({ root: "nope", path: "" })}`)).status).toBe(404);

    // Deleting the escaping link removes only the link, never the target.
    expect(
      (await admin.post("/api/files/delete", { root: "dev", paths: ["escape"], confirm: true }))
        .status,
    ).toBe(204);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  it("reads and writes text with conflict detection", async () => {
    const { admin, viewer, operator, root } = await setup();
    writeFileSync(join(root, "notes.txt"), "eski");
    writeFileSync(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0, 0, 1]));
    const text = await json<TextFile>(
      await admin.get(`/api/files/text?${q({ root: "dev", path: "notes.txt" })}`),
    );
    expect(text.content).toBe("eski");
    expect(
      await code(await admin.get(`/api/files/text?${q({ root: "dev", path: "image.bin" })}`)),
    ).toBe("FILES_NOT_TEXT");

    const saved = await admin.request("PUT", "/api/files/text", {
      body: { root: "dev", path: "notes.txt", content: "yeni içerik", etag: text.etag },
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("yeni içerik");
    // The old version is stale now.
    const stale = await admin.request("PUT", "/api/files/text", {
      body: { root: "dev", path: "notes.txt", content: "kayıp", etag: text.etag },
    });
    expect(stale.status).toBe(409);
    // Creating refuses existing names; viewers cannot write at all.
    expect(
      (
        await operator.request("PUT", "/api/files/text", {
          body: { root: "dev", path: "notes.txt", content: "x", etag: null },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await operator.request("PUT", "/api/files/text", {
          body: { root: "dev", path: "new.md", content: "# Başlık", etag: null },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await viewer.request("PUT", "/api/files/text", {
          body: { root: "dev", path: "v.txt", content: "x", etag: null },
        })
      ).status,
    ).toBe(403);
    expect(readdirSync(root).filter((n) => n.includes("everyos"))).toEqual([]);
  });

  it("streams uploads without overwriting by accident and checks free space", async () => {
    const { admin, root } = await setup();
    const upload = (
      name: string,
      body: string,
      extra: Record<string, string> = {},
      headers: Record<string, string> = {},
    ) =>
      admin.request("POST", `/api/files/upload?${q({ root: "dev", path: "", name, ...extra })}`, {
        rawBody: body,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      });
    expect((await upload("big.dat", "0123456789")).status).toBe(201);
    expect(readFileSync(join(root, "big.dat"), "utf8")).toBe("0123456789");
    expect((await upload("big.dat", "other")).status).toBe(409);
    expect((await upload("big.dat", "other", { overwrite: "true" })).status).toBe(201);
    expect(readFileSync(join(root, "big.dat"), "utf8")).toBe("other");
    // A body longer than announced is rejected and leaves no partial file.
    expect((await upload("short.dat", "0123456789", {}, { "content-length": "4" })).status).toBe(
      400,
    );
    expect(readdirSync(root).filter((n) => n.startsWith(".everyos") || n === "short.dat")).toEqual(
      [],
    );
    expect((await upload("../x", "x")).status).toBe(400);

    const tight = await setup((config) => {
      config.files.minFreeBytes = Number.MAX_SAFE_INTEGER;
    });
    const full = await tight.admin.request(
      "POST",
      `/api/files/upload?${q({ root: "dev", path: "", name: "a" })}`,
      {
        rawBody: "abc",
        headers: { "content-length": "3" },
      },
    );
    expect(full.status).toBe(507);
    expect(await code(full)).toBe("FILES_INSUFFICIENT_SPACE");
  });

  it("downloads as attachments with ranges, never as active content", async () => {
    const { admin, root } = await setup();
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    writeFileSync(join(root, "photo.png"), Buffer.alloc(100, 7));
    const html = await admin.get(
      `/api/files/download?${q({ root: "dev", path: "page.html", inline: "true" })}`,
    );
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toMatch(/^attachment; filename="page.html"/);
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    const image = await admin.get(
      `/api/files/download?${q({ root: "dev", path: "photo.png", inline: "true" })}`,
    );
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toMatch(/^inline/);
    const range = await admin.get(`/api/files/download?${q({ root: "dev", path: "photo.png" })}`, {
      headers: { range: "bytes=10-19" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 10-19/100");
    expect((await range.arrayBuffer()).byteLength).toBe(10);
    expect(
      (
        await admin.get(`/api/files/download?${q({ root: "dev", path: "photo.png" })}`, {
          headers: { range: "bytes=500-" },
        })
      ).status,
    ).toBe(416);
  });

  it("creates, renames, copies, moves, searches and deletes with audit entries", async () => {
    const { ctx, admin, root } = await setup();
    expect(
      (await admin.post("/api/files/mkdir", { root: "dev", path: "", name: "Projeler" })).status,
    ).toBe(201);
    writeFileSync(join(root, "Projeler", "plan.txt"), "plan");
    expect(
      (await admin.post("/api/files/mkdir", { root: "dev", path: "", name: "Projeler" })).status,
    ).toBe(409);
    expect(
      (
        await admin.post("/api/files/rename", {
          root: "dev",
          path: "Projeler/plan.txt",
          name: "yol-haritası.txt",
        })
      ).status,
    ).toBe(204);
    // Duplicate (copy with a new name) and copying a folder into itself.
    expect(
      (
        await admin.post("/api/files/copy", {
          root: "dev",
          paths: ["Projeler"],
          destination: { root: "dev", path: "" },
          name: "Projeler (kopya)",
        })
      ).status,
    ).toBe(204);
    expect(readFileSync(join(root, "Projeler (kopya)", "yol-haritası.txt"), "utf8")).toBe("plan");
    expect(
      (
        await admin.post("/api/files/copy", {
          root: "dev",
          paths: ["Projeler"],
          destination: { root: "dev", path: "Projeler" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/files/move", {
          root: "dev",
          paths: ["Projeler"],
          destination: { root: "dev", path: "" },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await admin.post("/api/files/move", {
          root: "dev",
          paths: ["Projeler (kopya)/yol-haritası.txt"],
          destination: { root: "dev", path: "" },
        })
      ).status,
    ).toBe(204);
    expect(readdirSync(join(root, "Projeler (kopya)"))).toEqual([]);

    const found = await json<FileSearchResult>(
      await admin.get(`/api/files/search?${q({ root: "dev", path: "", q: "HARİTA" })}`),
    );
    expect(found.results.map((r) => r.path).sort()).toEqual([
      "Projeler/yol-haritası.txt",
      "yol-haritası.txt",
    ]);

    const props = await json<FileProperties>(
      await admin.get(`/api/files/properties?${q({ root: "dev", path: "Projeler" })}`),
    );
    expect(props).toMatchObject({ type: "directory", children: 1, name: "Projeler" });

    // Deleting needs explicit confirmation and never targets the root.
    expect(
      (await admin.post("/api/files/delete", { root: "dev", paths: ["Projeler"] })).status,
    ).toBe(400);
    expect(
      (await admin.post("/api/files/delete", { root: "dev", paths: [""], confirm: true })).status,
    ).toBe(403);
    expect(
      (
        await admin.post("/api/files/delete", {
          root: "dev",
          paths: ["Projeler", "yol-haritası.txt"],
          confirm: true,
        })
      ).status,
    ).toBe(204);
    expect(readdirSync(root).sort()).toEqual([".otuken-trash", "Projeler (kopya)"]);

    const actions = ctx.db
      .all<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'files.%' AND outcome = 'success' ORDER BY id",
      )
      .map((row) => row.action);
    expect(actions).toEqual([
      "files.mkdir",
      "files.rename",
      "files.copy",
      "files.move",
      "files.move",
      "files.delete",
    ]);
  });

  it("matches a capital I in searches whatever language the query is typed in", async () => {
    const { admin, root } = await setup();
    // Turkish lower-casing turns "I" into dotless "ı"; "img" must still find a camera photo.
    writeFileSync(join(root, "IMG_1234.jpg"), "photo");
    writeFileSync(join(root, "Işık.txt"), "light");
    for (const [query, name] of [
      ["img", "IMG_1234.jpg"],
      ["IMG", "IMG_1234.jpg"],
      ["işık", "Işık.txt"],
      ["IŞIK", "Işık.txt"],
    ] as const) {
      const found = await json<FileSearchResult>(
        await admin.get(`/api/files/search?${q({ root: "dev", path: "", q: query })}`),
      );
      expect(
        found.results.map((r) => r.name),
        query,
      ).toEqual([name]);
    }
  });

  it("respects read-only roots and a missing configuration", async () => {
    const readOnly = await setup((config) => {
      config.files.roots = config.files.roots.map((r) => ({ ...r, readOnly: true }));
    });
    const refused = await readOnly.admin.post("/api/files/mkdir", {
      root: "dev",
      path: "",
      name: "x",
    });
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("FILES_READ_ONLY");
    const disabled = await setup((config) => {
      config.files.roots = [];
      config.files.homesDir = null;
    });
    const list = await disabled.admin.get(`/api/files/roots`);
    expect(list.status).toBe(404);
    expect(await code(list)).toBe("FILES_DISABLED");
  });

  it("gives every user a private home with fixed standard folders", async () => {
    const { admin, operator } = await setup();
    const roots = await json<FileRootsResponse>(await admin.get("/api/files/roots"));
    expect(roots.roots[0]).toMatchObject({
      id: "home",
      name: "admin",
      kind: "home",
      readOnly: false,
      folders: {
        desktop: "Masaüstü",
        documents: "Belgeler",
        downloads: "İndirilenler",
        pictures: "Resimler",
        music: "Müzik",
        videos: "Videolar",
      },
    });
    const home = await json<FileListing>(
      await admin.get(`/api/files/list?${q({ root: "home", path: "" })}`),
    );
    expect(home.entries.map((e) => e.name).sort()).toEqual([
      "Belgeler",
      "Masaüstü",
      "Müzik",
      "Resimler",
      "Videolar",
      "İndirilenler",
    ]);
    // The standard folders stay put; their contents are the user's.
    for (const response of [
      await admin.post("/api/files/rename", { root: "home", path: "Belgeler", name: "Docs" }),
      await admin.post("/api/files/delete", { root: "home", paths: ["Resimler"], confirm: true }),
      await admin.post("/api/files/move", {
        root: "home",
        paths: ["Müzik"],
        destination: { root: "dev", path: "" },
      }),
    ]) {
      expect(response.status).toBe(403);
      expect(await code(response)).toBe("FILES_PROTECTED");
    }
    expect(
      (await admin.post("/api/files/mkdir", { root: "home", path: "Belgeler", name: "Faturalar" }))
        .status,
    ).toBe(201);
    expect(
      (
        await admin.post("/api/files/rename", {
          root: "home",
          path: "Belgeler/Faturalar",
          name: "Makbuzlar",
        })
      ).status,
    ).toBe(204);
    // Homes are private: another user's "home" is their own.
    const other = await json<FileListing>(
      await operator.get(`/api/files/list?${q({ root: "home", path: "Belgeler" })}`),
    );
    expect(other.entries).toEqual([]);
  });

  it("adds standard folders of newer versions without renaming existing ones", async () => {
    const { ctx, admin } = await setup();
    const { id } = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!;
    const home = join(ctx.config.files.homesDir!, id);
    const manifest = join(home, ".otuken-folders.json");
    // A home created before the Desktop folder existed, named in English back then.
    const before = {
      documents: "Documents",
      downloads: "Downloads",
      pictures: "Pictures",
      music: "Music",
      videos: "Videos",
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(manifest, JSON.stringify(before));
    const roots = await json<FileRootsResponse>(await admin.get("/api/files/roots"));
    expect(roots.roots[0]?.folders).toEqual({ desktop: "Masaüstü", ...before });
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual({ desktop: "Masaüstü", ...before });
    expect(readdirSync(home).sort()).toEqual([
      ".otuken-folders.json",
      "Documents",
      "Downloads",
      "Masaüstü",
      "Music",
      "Pictures",
      "Videos",
    ]);
  });

  it("offers read-only system locations only to administrators who turn them on", async () => {
    const { ctx, admin, operator } = await setup();
    const ids = async (client: TestClient) =>
      (await json<FileRootsResponse>(await client.get("/api/files/roots"))).roots.map((r) => r.id);
    expect((await ids(admin)).some((id) => id.startsWith("sys-"))).toBe(false);
    expect(
      (await operator.request("PUT", "/api/files/settings", { body: { systemRoots: true } }))
        .status,
    ).toBe(403);
    expect(
      (await admin.request("PUT", "/api/files/settings", { body: { systemRoots: true } })).status,
    ).toBe(200);
    expect(await ids(admin)).toEqual(expect.arrayContaining(["sys-root", "sys-etc"]));
    expect((await ids(operator)).some((id) => id.startsWith("sys-"))).toBe(false);

    const top = await json<FileListing>(
      await admin.get(`/api/files/list?${q({ root: "sys-root", path: "" })}`),
    );
    expect(top.entries.some((e) => e.name === "etc")).toBe(true);
    expect(top.entries.some((e) => e.name === "dev" || e.name === "proc")).toBe(false);
    expect(
      (await admin.get(`/api/files/list?${q({ root: "sys-root", path: "dev" })}`)).status,
    ).toBe(404);
    const write = await admin.post("/api/files/mkdir", { root: "sys-etc", path: "", name: "x" });
    expect(write.status).toBe(403);
    expect(await code(write)).toBe("FILES_READ_ONLY");
    expect(
      ctx.db
        .all<{ action: string }>("SELECT action FROM audit_events WHERE action = 'files.settings'")
        .map((row) => row.action),
    ).toEqual(["files.settings"]);
  });
});
