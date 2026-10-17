import type { NotificationList, PowerActionResult } from "@everyos/shared";
import { describe, expect, it, vi } from "vitest";
import { HostMonitor } from "./modules/notifications/host-monitor.ts";
import { json, STRONG_PASSWORD, withRoles } from "./test-support.ts";

const request = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  confirm: action,
  password: STRONG_PASSWORD,
  ...extra,
});

describe("host power", () => {
  it("lets only an administrator who re-enters the password restart or power off the host", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    expect((await operator.post("/api/system/power", request("reboot"))).status).toBe(403);
    expect((await viewer.get("/api/system/power/blockers")).status).toBe(403);
    expect(
      (await admin.post("/api/system/power", { ...request("reboot"), confirm: "shutdown" })).status,
    ).toBe(422);
    expect(
      (await admin.post("/api/system/power", { ...request("reboot"), shell: "x" })).status,
    ).toBe(400);
    const wrong = await admin.post("/api/system/power", { ...request("reboot"), password: "nope" });
    expect(wrong.status).toBe(400);
    expect(ctx.agent.calls.some((call) => call.op === "power.control")).toBe(false);

    const accepted = await admin.post("/api/system/power", request("shutdown"));
    expect(accepted.status).toBe(202);
    expect(await json<PowerActionResult>(accepted)).toMatchObject({ action: "shutdown" });
    const call = ctx.agent.calls.find((entry) => entry.op === "power.control")!;
    expect(call.params).toEqual({ action: "shutdown" });
    expect(call.actor).toMatchObject({ kind: "user", username: "admin" });
    const audit = JSON.stringify(
      ctx.db.all("SELECT * FROM audit_events WHERE action = 'system.power'"),
    );
    expect(audit).toContain("success");
    expect(audit).toContain("failure");
    expect(audit).not.toContain(STRONG_PASSWORD);
    // Everyone who can see the system learns who powered it off.
    const seen = await json<NotificationList>(await viewer.get("/api/notifications"));
    expect(seen.notifications.find((n) => n.kind === "power-scheduled")?.params).toEqual({
      power: "shutdown",
      user: "admin",
    });
  });

  it("names running work and refuses an EveryOS update even when forced", async () => {
    const { ctx, admin } = await withRoles();
    expect(await json(await admin.get("/api/system/power/blockers"))).toEqual({ blockers: [] });
    let releaseState = "installing";
    ctx.agent.handlers.set("release.status", () => ({ job: { id: "job", state: releaseState } }));
    const jobs = vi.spyOn(ctx.services.apps, "activeJobs").mockReturnValue(1);
    expect(await json(await admin.get("/api/system/power/blockers"))).toEqual({
      blockers: ["release-install", "app-jobs"],
    });
    const forced = await admin.post("/api/system/power", request("reboot", { force: true }));
    expect(forced.status).toBe(409);
    expect(await forced.text()).toContain("release-install");
    releaseState = "succeeded";
    const busy = await admin.post("/api/system/power", request("reboot"));
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain("app-jobs");
    expect(ctx.agent.calls.some((call) => call.op === "power.control")).toBe(false);
    expect((await admin.post("/api/system/power", request("reboot", { force: true }))).status).toBe(
      202,
    );
    jobs.mockRestore();
  });

  it("raises a reboot-required condition while updates wait for a restart", async () => {
    const { ctx, viewer } = await withRoles();
    const monitor = new HostMonitor({
      agent: ctx.agent,
      notifications: ctx.services.notifications,
      logger: ctx.services.logger,
    });
    let required = true;
    ctx.agent.handlers.set("power.reboot.status", () => ({
      source: "host",
      required,
      reasons: required ? ["flag", "kernel"] : [],
      packages: required ? ["linux-image-6.8.0-2-raspi", "libc6"] : [],
      kernel: "6.8.0-1-raspi",
    }));
    await monitor.check();
    let seen = await json<NotificationList>(await viewer.get("/api/notifications"));
    expect(seen.notifications.find((n) => n.kind === "reboot-required")).toMatchObject({
      severity: "warning",
      resolvedAt: null,
      params: { packages: 2, kernel: 1 },
    });
    required = false;
    await monitor.check();
    seen = await json<NotificationList>(await viewer.get("/api/notifications"));
    expect(seen.notifications.find((n) => n.kind === "reboot-required")?.resolvedAt).not.toBeNull();
    expect(await json(await viewer.get("/api/system/power/reboot"))).toMatchObject({
      required: false,
    });
  });
});
