import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { openDatabase } from "@otuken/database";
import { silentLogger } from "@otuken/logger";
import type {
  BackupJobView,
  BackupOverview,
  BackupView,
  NotificationList,
  RestorePreview,
  TaskRunView,
  TaskView,
  FileRootsResponse,
  TrashListing,
} from "@otuken/shared";
import { TarWriter } from "@otuken/system/archive";
import { describe, expect, it, vi } from "vitest";
import { applyPendingRestore, pendingRestore } from "./modules/backups/snapshot.ts";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
  withRoles,
  type TestContext,
} from "./test-support.ts";

async function finished(ctx: TestContext, client: TestClient): Promise<BackupJobView> {
  await vi.waitFor(() => expect(ctx.services.backups.job()).toBeNull(), { timeout: 10_000 });
  return (await json<BackupOverview>(await client.get("/api/backups"))).lastJob!;
}

async function overview(client: TestClient): Promise<BackupOverview> {
  return json<BackupOverview>(await client.get("/api/backups"));
}

async function backup(ctx: TestContext, client: TestClient, body: object = {}): Promise<string> {
  const response = await client.post("/api/backups", body);
  expect(response.status).toBe(202);
  await vi.waitFor(() => expect(ctx.services.backups.job()).toBeNull(), { timeout: 10_000 });
  const list = await overview(client);
  expect(list.lastJob).toMatchObject({ kind: "backup", status: "succeeded" });
  return list.lastJob!.backupId!;
}

function snapshotOf(ctx: TestContext, id: string, workName = "check.db") {
  const path = join(ctx.dir, workName);
  writeFileSync(path, gunzipSync(readFileSync(join(ctx.config.backups.dir, id, "otuken.db.gz"))));
  return openDatabase(path, { readOnly: true });
}

/** A managed app whose data lives in its app data directory, answered by a fake agent. */
function fakeApp(ctx: TestContext) {
  const id = randomUUID();
  ctx.db.run(
    "INSERT INTO installed_apps(id, name, project, provenance, sealed_compose, risk_override, source, installed_at, metadata) VALUES (?, ?, ?, ?, ?, 0, 'simulated', 1, ?)",
    id,
    JSON.stringify({ en: "Notes" }),
    `otk-${id.replaceAll("-", "")}`,
    JSON.stringify({}),
    ctx.services.secrets.seal("services: {}\n", `app:${id}:compose:v1`),
    JSON.stringify({ dataCopyEligible: true }),
  );
  const state = {
    data: Buffer.alloc(0),
    imported: null as Buffer | null,
    exportBuffer: Buffer.alloc(0),
  };
  const build = async (content: string) => {
    const chunks: Buffer[] = [];
    const writer = new TarWriter((chunk) => {
      chunks.push(Buffer.from(chunk));
      return Promise.resolve();
    });
    await writer.directory({ name: "data", mode: 0o777, mtime: 0 });
    await writer.file(
      { name: "data/notes.txt", size: content.length, mode: 0o644, mtime: 0 },
      Buffer.from(content),
    );
    await writer.end();
    return gzipSync(Buffer.concat(chunks));
  };
  let offset = 0;
  let upload: Buffer[] = [];
  ctx.agent.handlers.set("backups.appdata.export.begin", async () => {
    state.exportBuffer = await build("version 1");
    offset = 0;
    return { token: "a".repeat(32), entries: 2, bytes: 9, skipped: 0 };
  });
  ctx.agent.handlers.set("backups.appdata.export.read", () => {
    if (offset >= state.exportBuffer.length)
      return {
        done: true,
        size: state.exportBuffer.length,
        sha256: createHash("sha256").update(state.exportBuffer).digest("hex"),
      };
    const part = state.exportBuffer.subarray(offset, offset + 40);
    offset += part.length;
    return { done: false, data: part.toString("base64") };
  });
  ctx.agent.handlers.set("backups.appdata.export.abort", () => ({ aborted: true }));
  ctx.agent.handlers.set("backups.appdata.import.begin", () => {
    upload = [];
    return { token: "b".repeat(32) };
  });
  ctx.agent.handlers.set("backups.appdata.import.chunk", (params) => {
    const { data } = params as { data: string };
    upload.push(Buffer.from(data, "base64"));
    return { received: Buffer.concat(upload).length };
  });
  ctx.agent.handlers.set("backups.appdata.import.commit", (params) => {
    const received = Buffer.concat(upload);
    if (
      createHash("sha256").update(received).digest("hex") !== (params as { sha256: string }).sha256
    )
      throw new Error("checksum");
    state.imported = received;
    return { entries: 2, bytes: 9 };
  });
  ctx.agent.handlers.set("backups.appdata.import.abort", () => ({ aborted: true }));
  return { id, state };
}

describe("backups", () => {
  it("includes account homes and trash automatically and restores them after taking a safety backup", async () => {
    const { ctx, admin, operator } = await withRoles();
    const home = async (client: TestClient) =>
      (await json<FileRootsResponse>(await client.get("/api/files/roots"))).roots.find(
        (root) => root.kind === "home",
      )!;
    const adminHome = await home(admin);
    const operatorHome = await home(operator);
    const path = `${adminHome.folders!.desktop}/saved.txt`;
    const trashedPath = `${adminHome.folders!.documents}/trash-note.txt`;
    const write = async (client: TestClient, file: string, content: string) => {
      const old = await client.get(
        `/api/files/text?${new URLSearchParams({ root: "home", path: file }).toString()}`,
      );
      const etag = old.ok ? (await json<{ etag: string }>(old)).etag : null;
      expect(
        (
          await client.request("PUT", "/api/files/text", {
            body: { root: "home", path: file, content, etag },
          })
        ).status,
      ).toBe(200);
    };
    await write(admin, path, "before backup");
    await write(operator, `${operatorHome.folders!.documents}/operator.txt`, "operator before");
    await write(admin, trashedPath, "recoverable in backup");
    expect(
      (await admin.post("/api/files/delete", { root: "home", paths: [trashedPath], confirm: true }))
        .status,
    ).toBe(204);
    const trashed = (await json<TrashListing>(await admin.get("/api/files/trash"))).entries[0]!;
    const id = await backup(ctx, admin);
    const saved = (await overview(admin)).backups.find((entry) => entry.id === id)!;
    expect(saved.contents.homes?.map((entry) => entry.username).sort()).toEqual([
      "admin",
      "operator",
    ]);
    expect(existsSync(join(ctx.config.backups.dir, id, "homes.tar.gz"))).toBe(true);
    expect(saved.verification?.ok).toBe(true);

    await write(admin, path, "after backup");
    await write(operator, `${operatorHome.folders!.documents}/operator.txt`, "operator after");
    expect(
      (
        await admin.post("/api/files/trash/delete", {
          root: "home",
          ids: [trashed.id],
          confirm: true,
        })
      ).status,
    ).toBe(204);
    await write(admin, `${adminHome.folders!.desktop}/later.txt`, "created later");
    expect(
      (
        await admin.post(`/api/backups/${id}/restore`, {
          settings: "none",
          apps: [],
          homes: true,
          password: STRONG_PASSWORD,
          confirm: true,
        })
      ).status,
    ).toBe(202);
    expect(await finished(ctx, admin)).toMatchObject({ status: "succeeded", restart: null });
    expect(
      (
        await json<{ content: string }>(
          await admin.get(
            `/api/files/text?${new URLSearchParams({ root: "home", path }).toString()}`,
          ),
        )
      ).content,
    ).toBe("before backup");
    expect(
      (
        await admin.get(
          `/api/files/text?${new URLSearchParams({ root: "home", path: `${adminHome.folders!.desktop}/later.txt` }).toString()}`,
        )
      ).status,
    ).toBe(404);
    const safety = (await overview(admin)).backups.find(
      (entry) => entry.trigger === "pre-restore",
    )!;
    expect(
      gunzipSync(readFileSync(join(ctx.config.backups.dir, safety.id, "homes.tar.gz"))).includes(
        Buffer.from("after backup"),
      ),
    ).toBe(true);
    expect((await json<TrashListing>(await admin.get("/api/files/trash"))).entries).toMatchObject([
      { id: trashed.id, name: "trash-note.txt" },
    ]);
    expect(
      (await admin.post("/api/files/trash/restore", { root: "home", ids: [trashed.id] })).status,
    ).toBe(204);
    expect(
      (
        await json<{ content: string }>(
          await admin.get(
            `/api/files/text?${new URLSearchParams({ root: "home", path: trashedPath }).toString()}`,
          ),
        )
      ).content,
    ).toBe("recoverable in backup");
    expect(
      ctx.db
        .all<{ details: string }>(
          "SELECT details FROM audit_events WHERE action = 'backups.restore'",
        )
        .some((row) => JSON.parse(row.details).homes === true),
    ).toBe(true);
  });

  it("reads older backups without homes and includes homes in scheduled backups", async () => {
    const { ctx, admin } = await withRoles();
    const old = await backup(ctx, admin);
    const manifestPath = join(ctx.config.backups.dir, old, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contents: { homes?: unknown };
    };
    delete manifest.contents.homes;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(
      (await json<RestorePreview>(await admin.get(`/api/backups/${old}/preview`))).homes,
    ).toEqual([]);
    expect(
      (
        await admin.post(`/api/backups/${old}/restore`, {
          settings: "none",
          apps: [],
          homes: true,
          password: STRONG_PASSWORD,
          confirm: true,
        })
      ).status,
    ).toBe(202);
    expect(await finished(ctx, admin)).toMatchObject({ status: "failed", error: "no-home-users" });
    await admin.get("/api/files/roots");
    const scheduled = ctx.services.backups.create(
      { apps: [], trigger: "schedule" },
      {
        kind: "user",
        userId: ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username='admin'")!.id,
        username: "admin",
        role: "admin",
      },
    );
    const result = await ctx.services.backups.wait(scheduled.id);
    expect(result.status).toBe("succeeded");
    expect((await ctx.services.backups.get(result.backupId!)).contents.homes).toHaveLength(1);
  });

  it("creates verified backups of a session-free snapshot and applies retention", async () => {
    const { ctx, admin } = await withRoles();
    const first = await backup(ctx, admin, { note: "ilk" });
    const dir = join(ctx.config.backups.dir, first);
    expect(readdirSync(dir).sort()).toEqual(["apps", "info.json", "manifest.json", "otuken.db.gz"]);
    const snapshot = snapshotOf(ctx, first);
    expect(snapshot.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")!.n).toBe(0);
    expect(snapshot.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n).toBe(3);
    snapshot.close();

    const list = await overview(admin);
    expect(list.backups[0]).toMatchObject({
      id: first,
      trigger: "manual",
      createdBy: "admin",
      note: "ilk",
      pinned: false,
      sameKey: true,
      contents: { database: true, config: false, wallpapers: false, apps: [] },
      verification: { ok: true },
    });
    expect(
      await json<{ job: unknown; lastJob: { status: string } }>(
        await admin.get("/api/backups/job"),
      ),
    ).toMatchObject({
      job: null,
      lastJob: { status: "succeeded" },
    });
    expect(list.storage).toMatchObject({
      location: ctx.config.backups.dir,
      usedBytes: list.backups[0]!.size,
    });

    // Retention keeps the newest unpinned backups; pinned ones stay.
    expect(
      (await admin.request("PUT", "/api/backups/settings", { body: { keep: 2, appData: [] } }))
        .status,
    ).toBe(200);
    await admin.request("PUT", `/api/backups/${first}/pin`, { body: { pinned: true } });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ctx.clock.now += 60_000;
      ids.push(await backup(ctx, admin));
    }
    expect((await overview(admin)).backups.map((b) => b.id)).toEqual([ids[2], ids[1], first]);
    expect(
      ctx.db
        .all<{ action: string }>(
          "SELECT action FROM audit_events WHERE action LIKE 'backups.%' ORDER BY id",
        )
        .map((r) => r.action),
    ).toEqual([
      "backups.create",
      "backups.settings",
      "backups.pin",
      "backups.create",
      "backups.create",
      "backups.create",
    ]);
    const notes = await json<NotificationList>(
      await admin.get("/api/notifications?category=backups"),
    );
    expect(notes.notifications[0]).toMatchObject({ kind: "backup-succeeded", severity: "success" });
  });

  it("keeps restores, downloads and uploads to administrators", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    expect((await viewer.get("/api/backups")).status).toBe(403);
    const id = await backup(ctx, operator);
    expect((await operator.get(`/api/backups/${id}/preview`)).status).toBe(403);
    expect(
      (
        await operator.post(`/api/backups/${id}/restore`, {
          settings: "desktop",
          apps: [],
          password: STRONG_PASSWORD,
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await operator.post(`/api/backups/${id}/download`, { password: STRONG_PASSWORD })).status,
    ).toBe(403);
    expect((await admin.get(`/api/backups/${id}/preview`)).status).toBe(200);
    // Path tricks never reach the filesystem.
    expect((await admin.get("/api/backups/..%2F..%2Fsecret/preview")).status).toBe(400);
  });

  it("downloads with a password and a single-use link, and uploads only intact archives", async () => {
    const { ctx, admin } = await withRoles();
    const id = await backup(ctx, admin);
    expect(
      (await admin.post(`/api/backups/${id}/download`, { password: "wrong-password-123" })).status,
    ).toBe(400);
    const { url } = await json<{ url: string }>(
      await admin.post(`/api/backups/${id}/download`, { password: STRONG_PASSWORD }),
    );
    const download = await admin.get(url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(`otuken-backup-${id}.tar`);
    const archive = Buffer.from(await download.arrayBuffer());
    expect(archive.length).toBe(Number(download.headers.get("content-length")));
    expect((await admin.get(url)).status).toBe(403);

    const upload = (body: Uint8Array) =>
      admin.request("POST", "/api/backups/upload", {
        rawBody: body,
        headers: { "content-length": String(body.length), "content-type": "application/x-tar" },
      });
    expect((await upload(archive)).status).toBe(409);
    expect((await admin.delete(`/api/backups/${id}`)).status).toBe(204);
    // A flipped byte inside the database snapshot is caught by its checksum.
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1500] = tampered[tampered.length - 1500]! ^ 0xff;
    const bad = await upload(tampered);
    expect(bad.status).toBe(400);
    expect((await bad.json()) as object).toMatchObject({ error: { code: "BACKUP_INVALID" } });
    expect((await upload(Buffer.from("not a tar".repeat(100)))).status).toBe(400);
    const good = await upload(archive);
    expect(good.status).toBe(201);
    expect(await json<BackupView>(good)).toMatchObject({
      id,
      uploaded: true,
      verification: { ok: true },
    });
    expect(readdirSync(ctx.config.backups.dir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("restores every user's desktop in place after taking a safety backup", async () => {
    const { ctx, admin } = await withRoles();
    const prefs = {
      version: 1,
      toasts: false,
      toastMinSeverity: "critical",
      mutedCategories: ["apps"],
    };
    expect(
      (await admin.request("PUT", "/api/preferences/notifications", { body: prefs })).status,
    ).toBe(204);
    const id = await backup(ctx, admin);
    await admin.request("PUT", "/api/preferences/notifications", {
      body: { ...prefs, toasts: true, mutedCategories: [] },
    });
    const preview = await json<RestorePreview>(await admin.get(`/api/backups/${id}/preview`));
    expect(preview).toMatchObject({ databaseBlocked: null, config: "absent", apps: [] });
    expect(preview.desktopUsers).toContain("admin");
    expect(preview.database.users.map((u) => [u.username, u.status])).toEqual([
      ["admin", "same"],
      ["operator", "same"],
      ["viewer", "same"],
    ]);

    expect(
      (
        await admin.post(`/api/backups/${id}/restore`, {
          settings: "desktop",
          apps: [],
          password: "nope-nope-nope",
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.post(`/api/backups/${id}/restore`, {
          settings: "desktop",
          apps: [],
          password: STRONG_PASSWORD,
        })
      ).status,
    ).toBe(400);
    ctx.clock.now += 60_000;
    expect(
      (
        await admin.post(`/api/backups/${id}/restore`, {
          settings: "desktop",
          apps: [],
          password: STRONG_PASSWORD,
          confirm: true,
        })
      ).status,
    ).toBe(202);
    expect(await finished(ctx, admin)).toMatchObject({
      kind: "restore",
      status: "succeeded",
      restart: null,
    });
    const restored = await json<{ preferences: Record<string, unknown> }>(
      await admin.get("/api/preferences"),
    );
    expect(restored.preferences.notifications).toEqual(prefs);
    const all = (await overview(admin)).backups;
    expect(all.map((b) => b.trigger)).toEqual(["pre-restore", "manual"]);
    expect(all[0]!.note).toBe(id);
  });

  it("never restores wallpaper records that name paths outside the wallpaper directory", async () => {
    const { ctx, admin } = await withRoles();
    const id = await backup(ctx, admin);
    const adminId = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
    // Tamper with the snapshot and re-seal the manifest, as someone with file access could.
    const dir = join(ctx.config.backups.dir, id);
    const snapshot = join(ctx.dir, "tamper.db");
    writeFileSync(snapshot, gunzipSync(readFileSync(join(dir, "otuken.db.gz"))));
    const db = openDatabase(snapshot);
    db.run(
      "INSERT INTO wallpapers(id, user_id, mime, size, width, height, file_name, created_at) VALUES ('w1', ?, 'image/png', 1, 1, 1, '../../secret.key', 1)",
      adminId,
    );
    db.run(
      "INSERT INTO wallpapers(id, user_id, mime, size, width, height, file_name, created_at) VALUES ('w2', ?, 'image/png', 1, 1, 1, 'abcDEF_12.png', 1)",
      adminId,
    );
    db.exec("PRAGMA journal_mode = DELETE");
    db.close();
    const gz = gzipSync(readFileSync(snapshot));
    writeFileSync(join(dir, "otuken.db.gz"), gz);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      files: { name: string; size: number; sha256: string }[];
    };
    manifest.files[0] = {
      name: "otuken.db.gz",
      size: gz.length,
      sha256: createHash("sha256").update(gz).digest("hex"),
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));

    await admin.post(`/api/backups/${id}/restore`, {
      settings: "desktop",
      apps: [],
      password: STRONG_PASSWORD,
      confirm: true,
    });
    expect(await finished(ctx, admin)).toMatchObject({ status: "succeeded" });
    expect(
      ctx.db.all<{ id: string }>("SELECT id FROM wallpapers ORDER BY id").map((row) => row.id),
    ).toEqual(["w2"]);
  });

  it("stages a full database restore that the next start applies", async () => {
    const { ctx, admin } = await withRoles();
    const id = await backup(ctx, admin);
    await admin.post("/api/users", {
      username: "sonradan",
      displayName: "Sonradan",
      password: STRONG_PASSWORD,
      role: "viewer",
    });
    const preview = await json<RestorePreview>(await admin.get(`/api/backups/${id}/preview`));
    expect(preview.database.users.find((u) => u.username === "sonradan")?.status).toBe("removed");
    await admin.post(`/api/backups/${id}/restore`, {
      settings: "database",
      apps: [],
      password: STRONG_PASSWORD,
      confirm: true,
    });
    expect(await finished(ctx, admin)).toMatchObject({ status: "succeeded", restart: "manual" });
    expect(await pendingRestore(ctx.config.paths.dataDir)).toMatchObject({
      backupId: id,
      requestedBy: "admin",
    });

    // What the API does on its next start, before it opens the database.
    const applied = await applyPendingRestore({
      dataDir: ctx.config.paths.dataDir,
      databaseFile: ctx.config.paths.databaseFile,
      backupDir: ctx.config.paths.backupDir,
      logger: silentLogger,
    });
    expect(applied).toMatchObject({ backupId: id });
    expect(existsSync(applied!.previous!)).toBe(true);
    const reopened = openDatabase(ctx.config.paths.databaseFile);
    expect(
      reopened
        .all<{ username: string }>("SELECT username FROM users ORDER BY username")
        .map((u) => u.username),
    ).toEqual(["admin", "operator", "viewer"]);
    reopened.close();
    expect(await pendingRestore(ctx.config.paths.dataDir)).toBeNull();
  });

  it("refuses database restores from another installation's secret", async () => {
    const { ctx, admin } = await withRoles();
    const id = await backup(ctx, admin);
    const path = join(ctx.config.backups.dir, id, "manifest.json");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/"keyId": "[a-f0-9]+"/, `"keyId": "${"0".repeat(32)}"`),
    );
    const preview = await json<RestorePreview>(await admin.get(`/api/backups/${id}/preview`));
    expect(preview).toMatchObject({ databaseBlocked: "different-key", backup: { sameKey: false } });
    await admin.post(`/api/backups/${id}/restore`, {
      settings: "database",
      apps: [],
      password: STRONG_PASSWORD,
      confirm: true,
    });
    expect(await finished(ctx, admin)).toMatchObject({
      status: "failed",
      error: "BACKUP_INCOMPATIBLE:different-key",
    });
    expect(await pendingRestore(ctx.config.paths.dataDir)).toBeNull();
  });

  it("captures app data while the app is stopped and restores it through the agent", async () => {
    const { ctx, admin } = await withRoles();
    const app = fakeApp(ctx);
    // The app runs: the backup stops it for the copy and starts it again.
    const actions: string[] = [];
    vi.spyOn(ctx.services.apps, "list").mockImplementation(() =>
      Promise.resolve([
        {
          id: app.id,
          name: { en: "Notes" },
          state: actions.at(-1) === "stop" ? "stopped" : "running",
        } as never,
      ]),
    );
    vi.spyOn(ctx.services.apps, "control").mockImplementation((_id, action) => {
      actions.push(action);
      return Promise.resolve({ id: `job-${action}` } as never);
    });
    vi.spyOn(ctx.services.apps, "job").mockImplementation(() => ({ stage: "succeeded" }) as never);

    const id = await backup(ctx, admin, { apps: [app.id] });
    expect(actions).toEqual(["stop", "start"]);
    const view = (await overview(admin)).backups[0]!;
    expect(view.contents.apps).toEqual([
      { id: app.id, name: { en: "Notes" }, data: true, dataBytes: 9, dataEntries: 2, skipped: 0 },
    ]);
    const stored = readFileSync(join(ctx.config.backups.dir, id, "apps", `${app.id}.data.tar.gz`));
    expect(stored).toEqual(app.state.exportBuffer);

    const preview = await json<RestorePreview>(await admin.get(`/api/backups/${id}/preview`));
    expect(preview.apps).toEqual([
      { id: app.id, name: { en: "Notes" }, restorable: "ok", dataBytes: 9 },
    ]);
    actions.length = 0;
    ctx.clock.now += 60_000;
    await admin.post(`/api/backups/${id}/restore`, {
      settings: "none",
      apps: [app.id],
      password: STRONG_PASSWORD,
      confirm: true,
    });
    expect(await finished(ctx, admin)).toMatchObject({ status: "succeeded" });
    expect(app.state.imported).toEqual(stored);
    // Stopped and started for the safety backup, then for the restore.
    expect(actions).toEqual(["stop", "start", "stop", "start"]);
    const safety = (await overview(admin)).backups[0]!;
    expect(safety).toMatchObject({
      trigger: "pre-restore",
      contents: { apps: [{ id: app.id, data: true }] },
    });

    // Apps whose data is not in their app data directory cannot be selected.
    ctx.db.run("UPDATE installed_apps SET metadata = '{}' WHERE id = ?", app.id);
    expect((await admin.post("/api/backups", { apps: [app.id] })).status).toBe(400);
  });

  it("runs scheduled backups through the task runner", async () => {
    const { ctx, admin } = await withRoles();
    const task = await json<TaskView>(
      await admin.post("/api/tasks", {
        name: "Gece yedeği",
        type: "backup.create",
        params: {},
        schedule: "0 3 * * *",
      }),
    );
    await admin.post(`/api/tasks/${task.id}/run`, {});
    await vi.waitFor(() => expect(ctx.services.tasks.runs(task.id)[0]?.status).toBe("succeeded"), {
      timeout: 10_000,
    });
    const run: TaskRunView = ctx.services.tasks.runs(task.id)[0]!;
    const list = (await overview(admin)).backups;
    expect(list[0]).toMatchObject({ trigger: "schedule", id: run.summary });
  });

  it("refuses to fill the disk and reports the failure", async () => {
    const ctx = await createTestContext({
      configure: (config) => {
        config.backups.minFreeBytes = Number.MAX_SAFE_INTEGER;
      },
    });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    await ctx.services.backups.start();
    await admin.post("/api/backups", {});
    expect(await finished(ctx, admin)).toMatchObject({
      status: "failed",
      error: "BACKUP_INSUFFICIENT_SPACE",
    });
    expect((await overview(admin)).backups).toEqual([]);
    expect(readdirSync(ctx.config.backups.dir)).toEqual([]);
    const notes = await json<NotificationList>(
      await admin.get("/api/notifications?category=backups"),
    );
    expect(notes.notifications[0]).toMatchObject({
      kind: "backup-failed",
      params: { reason: "BACKUP_INSUFFICIENT_SPACE" },
    });
  });
});
