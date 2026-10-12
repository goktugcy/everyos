import { describe, expect, it, vi } from "vitest";
import {
  withRoles,
  createTestContext,
  TestClient,
  completeSetup,
  STRONG_PASSWORD,
  json,
} from "./test-support.ts";
import { CSRF_HEADER, EVERYOS_VERSION, type BackupJobView } from "@everyos/shared";
import { randomUUID } from "node:crypto";

describe("EveryOS update authorization and safety backup", () => {
  it("requires authentication and administrator permission for preparation and installation", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    expect((await new TestClient(ctx).get("/api/self-update")).status).toBe(401);
    for (const client of [operator, viewer]) {
      expect((await client.post("/api/self-update/prepare", {})).status).toBe(403);
      expect((await client.post("/api/self-update/install", {})).status).toBe(403);
    }
    expect(
      (
        await admin.post("/api/self-update/install", {
          version: "0.2.0",
          confirm: true,
          url: "https://attacker.invalid",
        })
      ).status,
    ).toBe(400);
  });
  it("installs with a verified homes backup without password reauthentication, including legacy clients", async () => {
    const ctx = await createTestContext();
    ctx.clock.now = Date.now();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const job = await json<BackupJobView>(await admin.post("/api/self-update/prepare", {}));
    const done = await ctx.services.backups.wait(job.id);
    expect(done.status, done.error ?? "backup").toBe("succeeded");
    const view = await ctx.services.backups.get(done.backupId!);
    expect(view.contents.homes).toBeDefined();
    expect(view.verification?.ok).toBe(true);
    const input = {
      version: "0.2.0",
      backupId: done.backupId,
      confirm: true,
    };
    const call = vi.spyOn(ctx.services.agent, "call");
    expect(
      (await admin.post("/api/self-update/install", { ...input, confirm: false })).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/self-update/install", input, {
          headers: { [CSRF_HEADER]: "invalid" },
        })
      ).status,
    ).toBe(403);
    await admin.post("/api/auth/lock");
    expect((await admin.post("/api/self-update/install", input)).status).toBe(423);
    await admin.post("/api/auth/unlock", { password: STRONG_PASSWORD });
    expect(call).not.toHaveBeenCalled();
    const queued = {
      id: randomUUID(),
      version: "0.2.0",
      previousVersion: EVERYOS_VERSION,
      backupId: done.backupId!,
      state: "queued" as const,
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    // The API test stubs package installation; backup creation/verification remains real.
    call.mockResolvedValue(queued);
    for (const request of [input, { ...input, password: "legacy-client-password" }]) {
      const response = await admin.post("/api/self-update/install", request);
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await json(response)).toEqual(queued);
    }
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith(
      "release.install",
      input,
      expect.objectContaining({ kind: "user", role: "admin" }),
      expect.anything(),
    );
    expect((await ctx.services.backups.get(done.backupId!)).pinned).toBe(true);
  });
  it("rejects stale, foreign or invalid backups before invoking the agent", async () => {
    const ctx = await createTestContext();
    ctx.clock.now = Date.now();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const job = await json<BackupJobView>(await admin.post("/api/self-update/prepare", {}));
    const done = await ctx.services.backups.wait(job.id);
    expect(done.status).toBe("succeeded");
    const view = await ctx.services.backups.get(done.backupId!);
    const get = vi.spyOn(ctx.services.backups, "get");
    const call = vi.spyOn(ctx.services.agent, "call");
    const input = { version: "0.2.0", backupId: done.backupId, confirm: true };
    for (const invalid of [
      { createdAt: Date.now() - 31 * 60_000 },
      { createdBy: "another-admin" },
      {
        contents: {
          database: view.contents.database,
          config: view.contents.config,
          wallpapers: view.contents.wallpapers,
          apps: view.contents.apps,
        },
      },
    ]) {
      get.mockResolvedValueOnce({ ...view, ...invalid });
      expect((await admin.post("/api/self-update/install", input)).status).toBe(409);
    }
    vi.spyOn(ctx.services.backups, "verify").mockResolvedValueOnce({
      at: Date.now(),
      ok: false,
      error: "database",
    });
    expect((await admin.post("/api/self-update/install", input)).status).toBe(409);
    expect(call).not.toHaveBeenCalled();
  });
});
