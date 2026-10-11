import { describe, expect, it, vi } from "vitest";
import {
  withRoles,
  createTestContext,
  TestClient,
  completeSetup,
  STRONG_PASSWORD,
  json,
} from "./test-support.ts";
import type { BackupJobView } from "@everyos/shared";

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
          password: STRONG_PASSWORD,
          confirm: true,
          url: "https://attacker.invalid",
        })
      ).status,
    ).toBe(400);
  });
  it("creates a real verified homes backup and checks the password before invoking the agent", async () => {
    const ctx = await createTestContext();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const job = await json<BackupJobView>(await admin.post("/api/self-update/prepare", {}));
    const done = await ctx.services.backups.wait(job.id);
    expect(done.status, done.error ?? "backup").toBe("succeeded");
    const view = await ctx.services.backups.get(done.backupId!);
    expect(view.contents.homes).toBeDefined();
    expect(view.verification?.ok).toBe(true);
    const call = vi.spyOn(ctx.services.agent, "call");
    const denied = await admin.post("/api/self-update/install", {
      version: "0.2.0",
      backupId: done.backupId,
      password: "incorrect-password",
      confirm: true,
    });
    expect(denied.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
});
