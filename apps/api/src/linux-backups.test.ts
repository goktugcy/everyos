import { LinuxBackupService } from "./modules/backups/linux-backup-service.ts";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  LinuxBackupJob,
  LinuxBackupOverview,
  LinuxBackupPlan,
  LinuxBackupInstallation,
} from "@everyos/shared";
import { ROLE_PERMISSIONS } from "@everyos/shared";
import { AgentClientError } from "@everyos/agent-protocol";
import type { OperationParams } from "@everyos/agent-protocol";
import { json, STRONG_PASSWORD, withRoles, type TestContext } from "./test-support.ts";

const phrase = "Backup fixture passphrase 2026";
function backend(ctx: TestContext) {
  let latest: LinuxBackupJob | null = null;
  ctx.agent.handlers.set("backups.linux.status", () => ({
    source: "simulated",
    available: true,
    reason: "ready",
    version: "borg 1.4.5",
    installationSupported: false,
    targets: [
      {
        id: "a".repeat(16),
        path: "/fixture/backups",
        device: "123",
        freeBytes: 1024 ** 4,
        available: true,
      },
    ],
    systemIncludes: ["/etc", "/usr"],
    alwaysExcluded: ["/proc", "/sys", "/dev", "/run"],
  }));
  ctx.agent.handlers.set("backups.linux.start", (raw) => {
    const input = raw as OperationParams<"backups.linux.start">;
    latest = {
      id: randomUUID(),
      planId: input.spec.planId,
      kind: input.kind,
      status: "running",
      stage: "preparing",
      archive: input.archive,
      startedAt: ctx.clock.now,
      finishedAt: null,
      files: 0,
      bytes: 0,
      compressedBytes: 0,
      deduplicatedBytes: 0,
      error: null,
      restorePath: null,
    };
    return latest;
  });
  ctx.agent.handlers.set("backups.linux.job", () => {
    if (!latest) throw new Error("No fixture job");
    return {
      ...latest,
      status: "succeeded",
      stage: "done",
      archive: latest.archive ?? "eos-20261104T120000Z-12345678",
      finishedAt: ctx.clock.now,
      files: 10,
      bytes: 1024,
    };
  });
  ctx.agent.handlers.set("backups.linux.archives", () => ({ archives: [], limit: 1000 }));
}
const draft = () => ({
  name: "System backup",
  scope: "system",
  includes: [],
  excludes: ["/etc/private"],
  excludeCaches: true,
  targetId: "a".repeat(16),
  encryption: "repokey-blake2",
  passphrase: phrase,
  compression: "lz4",
  retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 12 },
  schedule: { frequency: "daily", hour: 3, minute: 15, weekday: 0, day: 1 },
  password: STRONG_PASSWORD,
});

describe("built-in Linux backup API", () => {
  it("denies viewers and operators before any privileged backup call", async () => {
    const { ctx, operator, viewer } = await withRoles();
    backend(ctx);
    const before = ctx.agent.calls.length;
    for (const client of [operator, viewer]) {
      expect((await client.get("/api/linux-backups")).status).toBe(403);
      expect((await client.post("/api/linux-backups/plans", draft())).status).toBe(403);
      expect(
        (
          await client.post("/api/linux-backups/preview", {
            scope: "full",
            includes: [],
            excludes: [],
            excludeCaches: true,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      ctx.agent.calls.slice(before).filter((c) => c.op.startsWith("backups.linux.")),
    ).toHaveLength(0);
  });

  it("requires reauthentication, strict paths and explicit plaintext consent", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    expect(
      (await admin.post("/api/linux-backups/plans", { ...draft(), password: "incorrect" })).status,
    ).toBe(400);
    expect(
      (await admin.post("/api/linux-backups/plans", { ...draft(), includes: ["/etc/../root"] }))
        .status,
    ).toBe(400);
    expect(
      (await admin.post("/api/linux-backups/plans", { ...draft(), shell: "arbitrary" })).status,
    ).toBe(400);
    const plain = { ...draft(), encryption: "none", passphrase: undefined };
    expect((await admin.post("/api/linux-backups/plans", plain)).status).toBe(400);
    expect(
      (await admin.post("/api/linux-backups/plans", { ...plain, unencryptedConsent: true })).status,
    ).toBe(201);
  });

  it("seals credentials with plan-specific context, exposes no secret and creates all four schedules", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const response = await admin.post("/api/linux-backups/plans", draft());
    expect(response.status).toBe(201);
    const plan = await json<LinuxBackupPlan>(response);
    expect(JSON.stringify(plan)).not.toContain(phrase);
    expect(JSON.stringify(plan)).not.toContain("sealedPassphrase");
    const stored = JSON.parse(
      ctx.db.get<{ value: string }>(
        "SELECT value FROM instance_settings WHERE key = 'linux-backup/plans/v1'",
      )!.value,
    ) as Array<{ id: string; sealedPassphrase: string }>;
    expect(stored[0]!.sealedPassphrase).not.toContain(phrase);
    expect(
      ctx.services.secrets.open(
        stored[0]!.sealedPassphrase,
        `everyos/linux-backup/${plan.id}/passphrase`,
      ),
    ).toBe(phrase);
    expect(() =>
      ctx.services.secrets.open(
        stored[0]!.sealedPassphrase,
        `everyos/linux-backup/${randomUUID()}/passphrase`,
      ),
    ).toThrow();
    for (const [frequency, cron] of [
      ["hourly", "15 * * * *"],
      ["daily", "15 3 * * *"],
      ["weekly", "15 3 * * 0"],
      ["monthly", "15 3 1 * *"],
    ]) {
      const update = await admin.request("PUT", `/api/linux-backups/plans/${plan.id}`, {
        body: { ...draft(), passphrase: undefined, schedule: { ...draft().schedule, frequency } },
      });
      expect(update.status).toBe(200);
      const value = await json<LinuxBackupPlan>(update);
      expect(ctx.services.tasks.get(value.taskId!).schedule).toBe(cron);
      expect(ctx.services.tasks.get(value.taskId!).params).toEqual({ planId: plan.id });
    }
    const overview = await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"));
    expect(JSON.stringify(overview)).not.toContain(phrase);
    expect(JSON.stringify(overview)).not.toContain("sealedPassphrase");
    const events = ctx.db.all<{ details: string }>(
      "SELECT details FROM audit_events WHERE action LIKE 'backups.linux.%'",
    );
    expect(JSON.stringify(events)).not.toContain(phrase);
    const disabled = await admin.request("PUT", `/api/linux-backups/plans/${plan.id}`, {
      body: {
        ...draft(),
        passphrase: undefined,
        schedule: { ...draft().schedule, frequency: "manual" },
      },
    });
    expect(disabled.status).toBe(200);
    expect((await json<LinuxBackupPlan>(disabled)).taskId).toBeNull();
  });

  it("runs the saved plan through the scheduler, records terminal state, and rechecks owner authority", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    expect((await admin.post(`/api/tasks/${plan.taskId}/run`, {})).status).toBe(202);
    await vi.waitFor(() =>
      expect(ctx.services.tasks.runs(plan.taskId!)[0]?.status).toBe("succeeded"),
    );
    const privileged = ctx.agent.calls.filter((c) => c.op === "backups.linux.start");
    expect(privileged).toHaveLength(1);
    expect((privileged[0]!.params as OperationParams<"backups.linux.start">).spec).toMatchObject({
      passphrase: phrase,
      scope: "system",
      excludes: ["/etc/private"],
    });
    const overview = await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"));
    expect(overview.history[0]).toMatchObject({ planId: plan.id, status: "succeeded", files: 10 });
    const task = ctx.services.tasks.get(plan.taskId!);
    ctx.db.run("UPDATE users SET role = 'operator' WHERE username = ?", task.owner);
    const refused = ctx.services.tasks.runNow(plan.taskId!, {
      permissions: ROLE_PERMISSIONS.admin,
    });
    await vi.waitFor(() =>
      expect(
        ctx.services.tasks.runs(plan.taskId!).find((run) => run.id === refused.id)?.status,
      ).toBe("failed"),
    );
    expect(ctx.agent.calls.filter((c) => c.op === "backups.linux.start")).toHaveLength(1);
  });
  it("exposes the Linux unlock reason and tracks task pause/custom scheduling accurately", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    ctx.agent.handlers.set("backups.linux.start", () => {
      throw new AgentClientError("AGENT_OPERATION_DENIED", "LINUX_SUDO_REQUIRED", "policy_denied");
    });
    const start = await admin.post(`/api/linux-backups/plans/${plan.id}/jobs`, {
      kind: "create",
      archive: null,
      password: STRONG_PASSWORD,
    });
    expect(start.status).toBe(403);
    expect(await json<{ error: { details: unknown } }>(start)).toMatchObject({
      error: { details: { reason: "LINUX_SUDO_REQUIRED" } },
    });
    const ownerId = ctx.db.get<{ id: string }>(
      "SELECT id FROM users WHERE username = ?",
      "admin",
    )!.id;
    ctx.services.tasks.update(
      plan.taskId!,
      { enabled: false },
      { id: ownerId, permissions: ROLE_PERMISSIONS.admin },
    );
    let overview = await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"));
    expect(overview.plans[0]).toMatchObject({
      enabled: false,
      schedule: { frequency: "daily" },
      nextRunAt: null,
    });
    ctx.services.tasks.update(
      plan.taskId!,
      { enabled: true, schedule: "0 2,14 * * *" },
      { id: ownerId, permissions: ROLE_PERMISSIONS.admin },
    );
    overview = await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"));
    expect(overview.plans[0]?.scheduleOverride).toBe("0 2,14 * * *");
  });
  it("protects dependency installation with administrator permission, confirmation and reauthentication", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    backend(ctx);
    for (const client of [operator, viewer])
      expect(
        (
          await client.post("/api/linux-backups/install", {
            confirm: true,
            password: STRONG_PASSWORD,
          })
        ).status,
      ).toBe(403);
    expect(
      (await admin.post("/api/linux-backups/install", { password: STRONG_PASSWORD })).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/linux-backups/install", {
          confirm: true,
          password: STRONG_PASSWORD,
          packages: ["another-package"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/linux-backups/install", {
          confirm: true,
          password: "wrong-password",
        })
      ).status,
    ).toBe(400);
    expect(
      (await admin.post("/api/linux-backups/install", { confirm: true, password: STRONG_PASSWORD }))
        .status,
    ).toBe(409);
    expect(ctx.agent.calls.filter((c) => c.op === "backups.linux.install")).toHaveLength(0);
  });

  it("persists installation progress, prevents duplicates and audits only the fixed dependency", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    let ready = false;
    ctx.agent.handlers.set("backups.linux.status", () => ({
      source: "simulated",
      available: ready,
      reason: ready ? "ready" : "borg-missing",
      version: ready ? "borg 1.4.5" : null,
      installationSupported: !ready,
      targets: [],
      systemIncludes: [],
      alwaysExcluded: [],
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.agent.streamHandlers.set("backups.linux.install", async function* () {
      yield { type: "stage", stage: "installing" };
      await gate;
      ready = true;
      yield { type: "stage", stage: "checking" };
      yield { type: "done", ok: true, error: null };
    });
    const response = await admin.post("/api/linux-backups/install", {
      confirm: true,
      password: STRONG_PASSWORD,
    });
    expect(response.status).toBe(202);
    const job = await json<LinuxBackupInstallation>(response);
    expect(job.status).toBe("running");
    expect(
      (await admin.post("/api/linux-backups/install", { confirm: true, password: STRONG_PASSWORD }))
        .status,
    ).toBe(409);
    release();
    await vi.waitFor(async () =>
      expect(
        (await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"))).installation,
      ).toMatchObject({ id: job.id, status: "succeeded", stage: "done" }),
    );
    expect(ctx.agent.calls.filter((c) => c.op === "backups.linux.install")).toHaveLength(1);
    const events = ctx.db.all<{ action: string; target: string; details: string }>(
      "SELECT action, target, details FROM audit_events WHERE action LIKE 'backups.linux.engine.install.%' ORDER BY id",
    );
    expect(events.map((e) => e.action)).toEqual([
      "backups.linux.engine.install.start",
      "backups.linux.engine.install.finish",
    ]);
    expect(events.every((e) => e.target === "borgbackup")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(STRONG_PASSWORD);
  });

  it("keeps sudo denial visible and permits a new confirmed attempt", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    ctx.agent.handlers.set("backups.linux.status", () => ({
      source: "simulated",
      available: false,
      reason: "borg-missing",
      version: null,
      installationSupported: true,
      targets: [],
      systemIncludes: [],
      alwaysExcluded: [],
    }));
    ctx.agent.streamHandlers.set("backups.linux.install", async function* () {
      yield await Promise.reject(
        new AgentClientError("AGENT_OPERATION_DENIED", "LINUX_SUDO_REQUIRED", "policy_denied"),
      );
    });
    const first = await json<LinuxBackupInstallation>(
      await admin.post("/api/linux-backups/install", { confirm: true, password: STRONG_PASSWORD }),
    );
    await vi.waitFor(async () =>
      expect(
        (await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"))).installation,
      ).toMatchObject({ id: first.id, status: "failed", error: "LINUX_SUDO_REQUIRED" }),
    );
    ctx.agent.streamHandlers.set("backups.linux.install", async function* () {
      yield await Promise.resolve({ type: "done", ok: false, error: "BORG_PACKAGE_VERSION" });
    });
    const retry = await admin.post("/api/linux-backups/install", {
      confirm: true,
      password: STRONG_PASSWORD,
    });
    expect(retry.status).toBe(202);
    await vi.waitFor(async () =>
      expect(
        (await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"))).installation
          ?.error,
      ).toBe("BORG_PACKAGE_VERSION"),
    );
  });
  it("marks a persisted unfinished installation interrupted after an API restart", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const id = randomUUID();
    ctx.db.run(
      "INSERT INTO instance_settings(key,value,updated_at) VALUES(?,?,?)",
      "linux-backup/installation/v1",
      JSON.stringify({
        id,
        status: "running",
        stage: "installing",
        startedAt: ctx.clock.now,
        finishedAt: null,
        error: null,
      }),
      ctx.clock.now,
    );
    new LinuxBackupService({
      db: ctx.db,
      agent: ctx.agent,
      secrets: ctx.services.secrets,
      audit: ctx.services.audit,
      now: () => ctx.clock.now,
    });
    const overview = await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"));
    expect(overview.installation).toMatchObject({
      id,
      status: "failed",
      stage: "done",
      error: "BORG_INSTALL_INTERRUPTED",
    });
  });
  it("finishes the interrupted installation record before shutdown closes the database", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    ctx.agent.handlers.set("backups.linux.status", () => ({
      source: "simulated",
      available: false,
      reason: "borg-missing",
      version: null,
      installationSupported: true,
      targets: [],
      systemIncludes: [],
      alwaysExcluded: [],
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.agent.streamHandlers.set("backups.linux.install", async function* () {
      yield { type: "stage", stage: "installing" };
      await gate;
      yield { type: "done", ok: true, error: null };
    });
    expect(
      (await admin.post("/api/linux-backups/install", { confirm: true, password: STRONG_PASSWORD }))
        .status,
    ).toBe(202);
    const stopping = ctx.services.linuxBackups.stop();
    release();
    await stopping;
    const overview = await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"));
    expect(overview.installation).toMatchObject({
      status: "failed",
      error: "BORG_INSTALL_INTERRUPTED",
      stage: "done",
    });
  });
  it("requires an exact archive, explicit confirmation and password before deletion", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    const path = `/api/linux-backups/plans/${plan.id}/jobs`;
    const body = {
      kind: "delete",
      archive: "eos-20261105T120000Z-12345678",
      password: STRONG_PASSWORD,
      confirm: true,
    };
    for (const client of [operator, viewer])
      expect((await client.post(path, body)).status).toBe(403);
    for (const invalid of [
      { ...body, confirm: undefined },
      { ...body, archive: null },
      { ...body, archive: "../repository" },
      { ...body, archive: "eos-*" },
      { ...body, password: "wrong-password" },
    ])
      expect((await admin.post(path, invalid)).status).toBe(400);
    expect(ctx.agent.calls.filter((c) => c.op === "backups.linux.start")).toHaveLength(0);
    expect((await admin.post(path, body)).status).toBe(202);
    expect(ctx.agent.calls.find((c) => c.op === "backups.linux.start")?.params).toMatchObject({
      kind: "delete",
      archive: body.archive,
      confirm: true,
    });
    await admin.get("/api/linux-backups");
    const events = ctx.db.all<{ action: string; details: string }>(
      "SELECT action, details FROM audit_events WHERE action LIKE 'backups.linux.delete.%'",
    );
    expect(events.map((e) => e.action)).toEqual([
      "backups.linux.delete.start",
      "backups.linux.delete.finish",
    ]);
    expect(JSON.stringify(events)).not.toContain(STRONG_PASSWORD);
  });
  it("pauses and resumes the saved schedule without losing credentials, and denies disabled backup creation", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    const owner = {
      id: ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id,
      permissions: ROLE_PERMISSIONS.admin,
    };
    ctx.services.tasks.update(plan.taskId!, { schedule: "0 2,14 * * *" }, owner);
    const saved = () =>
      ctx.db.get<{ value: string }>(
        "SELECT value FROM instance_settings WHERE key = 'linux-backup/plans/v1'",
      )!.value;
    const sealed = JSON.parse(saved())[0].sealedPassphrase as string;
    const paused = await json<LinuxBackupPlan>(
      await admin.request("PATCH", `/api/linux-backups/plans/${plan.id}/state`, {
        body: { enabled: false, password: STRONG_PASSWORD },
      }),
    );
    expect(paused).toMatchObject({
      enabled: false,
      taskId: plan.taskId,
      nextRunAt: null,
      schedule: plan.schedule,
      scheduleOverride: "0 2,14 * * *",
    });
    expect(JSON.parse(saved())[0].sealedPassphrase).toBe(sealed);
    expect(ctx.services.tasks.get(plan.taskId!)).toMatchObject({
      enabled: false,
      schedule: "0 2,14 * * *",
    });
    expect(
      (
        await admin.post(`/api/linux-backups/plans/${plan.id}/jobs`, {
          kind: "create",
          archive: null,
          password: STRONG_PASSWORD,
        })
      ).status,
    ).toBe(409);
    const run = ctx.services.tasks.runNow(plan.taskId!, owner);
    await vi.waitFor(() =>
      expect(ctx.services.tasks.runs(plan.taskId!).find((r) => r.id === run.id)?.status).toBe(
        "failed",
      ),
    );
    expect(ctx.agent.calls.filter((c) => c.op === "backups.linux.start")).toHaveLength(0);
    const resumed = await json<LinuxBackupPlan>(
      await admin.request("PATCH", `/api/linux-backups/plans/${plan.id}/state`, {
        body: { enabled: true, password: STRONG_PASSWORD },
      }),
    );
    expect(resumed).toMatchObject({
      enabled: true,
      taskId: plan.taskId,
      scheduleOverride: "0 2,14 * * *",
    });
    expect(resumed.nextRunAt).toBeGreaterThan(ctx.clock.now);
    expect(ctx.services.tasks.get(plan.taskId!)).toMatchObject({
      enabled: true,
      schedule: "0 2,14 * * *",
    });
    expect(JSON.parse(saved())[0].sealedPassphrase).toBe(sealed);
    expect(
      (
        await admin.request("PATCH", `/api/linux-backups/plans/${plan.id}/state`, {
          body: { enabled: false, password: STRONG_PASSWORD },
        })
      ).status,
    ).toBe(200);
    const edited = await json<LinuxBackupPlan>(
      await admin.request("PUT", `/api/linux-backups/plans/${plan.id}`, {
        body: { ...draft(), name: "Edited while disabled", passphrase: undefined },
      }),
    );
    expect(edited.enabled).toBe(false);
    expect(ctx.services.tasks.get(plan.taskId!).enabled).toBe(false);
    expect(
      (
        await admin.post(`/api/linux-backups/plans/${plan.id}/jobs`, {
          kind: "restore",
          archive: "eos-20261105T120000Z-12345678",
          password: STRONG_PASSWORD,
        })
      ).status,
    ).toBe(202);
  });

  it("requires administrator reauthentication and explicit plan deletion confirmation; preserves unrelated plans and archives", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    const other = await json<LinuxBackupPlan>(
      await admin.post("/api/linux-backups/plans", { ...draft(), name: "Unrelated plan" }),
    );
    const path = `/api/linux-backups/plans/${plan.id}`;
    for (const client of [operator, viewer]) {
      expect(
        (
          await client.request("PATCH", path + "/state", {
            body: { enabled: false, password: STRONG_PASSWORD },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await client.request("DELETE", path, {
            body: { confirm: true, password: STRONG_PASSWORD },
          })
        ).status,
      ).toBe(403);
    }
    for (const body of [
      { password: STRONG_PASSWORD },
      { confirm: false, password: STRONG_PASSWORD },
      { confirm: true, password: "wrong-password" },
      { confirm: true, password: STRONG_PASSWORD, deleteArchives: true },
    ])
      expect((await admin.request("DELETE", path, { body })).status).toBe(400);
    for (const body of [
      { enabled: "false", password: STRONG_PASSWORD },
      { enabled: false, password: "wrong-password" },
      { enabled: false, password: STRONG_PASSWORD, shell: "arbitrary" },
    ])
      expect((await admin.request("PATCH", path + "/state", { body })).status).toBe(400);
    const calls = ctx.agent.calls.length;
    const response = await admin.request("DELETE", path, {
      body: { confirm: true, password: STRONG_PASSWORD },
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ deleted: true, archivesPreserved: true });
    expect(ctx.agent.calls).toHaveLength(calls);
    expect(() => ctx.services.tasks.get(plan.taskId!)).toThrow();
    expect(ctx.services.tasks.get(other.taskId!).enabled).toBe(true);
    const stored = JSON.parse(
      ctx.db.get<{ value: string }>(
        "SELECT value FROM instance_settings WHERE key = 'linux-backup/plans/v1'",
      )!.value,
    ) as Array<{ id: string }>;
    expect(stored.map((p) => p.id)).toEqual([other.id]);
    expect(
      (
        await admin.post(path + "/jobs", {
          kind: "create",
          archive: null,
          password: STRONG_PASSWORD,
        })
      ).status,
    ).toBe(404);
    const events = ctx.db.all<{ action: string; details: string }>(
      "SELECT action,details FROM audit_events WHERE action LIKE 'backups.linux.plan.%'",
    );
    expect(
      events.some(
        (e) =>
          e.action === "backups.linux.plan.delete" &&
          JSON.parse(e.details).archivesPreserved === true,
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(phrase);
    expect(JSON.stringify(events)).not.toContain(STRONG_PASSWORD);
  });

  it("allows disabling a running plan without stopping it, but requires completion before plan removal", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    const job = await json<LinuxBackupJob>(
      await admin.post(`/api/linux-backups/plans/${plan.id}/jobs`, {
        kind: "create",
        archive: null,
        password: STRONG_PASSWORD,
      }),
    );
    ctx.agent.handlers.set("backups.linux.job", () => job);
    const path = `/api/linux-backups/plans/${plan.id}`;
    expect(
      (await admin.request("DELETE", path, { body: { confirm: true, password: STRONG_PASSWORD } }))
        .status,
    ).toBe(409);
    expect(
      (
        await admin.request("PATCH", path + "/state", {
          body: { enabled: false, password: STRONG_PASSWORD },
        })
      ).status,
    ).toBe(200);
    expect(ctx.services.tasks.get(plan.taskId!).enabled).toBe(false);
    expect(ctx.agent.calls.filter((c) => c.op === "backups.linux.cancel")).toHaveLength(0);
    expect((await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"))).job?.id).toBe(
      job.id,
    );
    ctx.agent.handlers.set("backups.linux.job", () => ({
      ...job,
      status: "cancelled",
      stage: "done",
      finishedAt: ctx.clock.now,
    }));
    await admin.get("/api/linux-backups");
    expect(
      (await admin.request("DELETE", path, { body: { confirm: true, password: STRONG_PASSWORD } }))
        .status,
    ).toBe(200);
  });

  it("keeps legacy plans enabled by default and persists disablement for a manual-only plan", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(
      await admin.post("/api/linux-backups/plans", {
        ...draft(),
        schedule: { ...draft().schedule, frequency: "manual" },
      }),
    );
    const read = (): Array<{ enabled?: boolean }> =>
      JSON.parse(
        ctx.db.get<{ value: string }>(
          "SELECT value FROM instance_settings WHERE key = 'linux-backup/plans/v1'",
        )!.value,
      ) as Array<{ enabled?: boolean }>;
    const legacy = read();
    delete legacy[0]!.enabled;
    ctx.db.run(
      "UPDATE instance_settings SET value = ? WHERE key = 'linux-backup/plans/v1'",
      JSON.stringify(legacy),
    );
    expect(
      (await json<LinuxBackupOverview>(await admin.get("/api/linux-backups"))).plans[0]?.enabled,
    ).toBe(true);
    const paused = await json<LinuxBackupPlan>(
      await admin.request("PATCH", `/api/linux-backups/plans/${plan.id}/state`, {
        body: { enabled: false, password: STRONG_PASSWORD },
      }),
    );
    expect(paused).toMatchObject({
      enabled: false,
      taskId: null,
      schedule: { frequency: "manual" },
    });
    expect(read()[0]!.enabled).toBe(false);
    expect(
      (
        await admin.post(`/api/linux-backups/plans/${plan.id}/jobs`, {
          kind: "create",
          archive: null,
          password: STRONG_PASSWORD,
        })
      ).status,
    ).toBe(409);
    const resumed = await json<LinuxBackupPlan>(
      await admin.request("PATCH", `/api/linux-backups/plans/${plan.id}/state`, {
        body: { enabled: true, password: STRONG_PASSWORD },
      }),
    );
    expect(resumed).toMatchObject({ enabled: true, taskId: null, nextRunAt: null });
    expect(ctx.services.tasks.list().filter((task) => task.type === "backup.linux")).toHaveLength(
      0,
    );
  });

  it("refuses to mutate an unrelated scheduled task through a stale plan link", async () => {
    const { ctx, admin } = await withRoles();
    backend(ctx);
    const plan = await json<LinuxBackupPlan>(await admin.post("/api/linux-backups/plans", draft()));
    const other = await json<LinuxBackupPlan>(
      await admin.post("/api/linux-backups/plans", { ...draft(), name: "Keep this plan" }),
    );
    const stored = JSON.parse(
      ctx.db.get<{ value: string }>(
        "SELECT value FROM instance_settings WHERE key = 'linux-backup/plans/v1'",
      )!.value,
    );
    stored[0].taskId = other.taskId;
    ctx.db.run(
      "UPDATE instance_settings SET value = ? WHERE key = 'linux-backup/plans/v1'",
      JSON.stringify(stored),
    );
    const path = `/api/linux-backups/plans/${plan.id}`;
    expect(
      (
        await admin.request("PATCH", path + "/state", {
          body: { enabled: false, password: STRONG_PASSWORD },
        })
      ).status,
    ).toBe(409);
    expect(
      (await admin.request("DELETE", path, { body: { confirm: true, password: STRONG_PASSWORD } }))
        .status,
    ).toBe(409);
    expect(ctx.services.tasks.get(other.taskId!).enabled).toBe(true);
    expect(ctx.services.tasks.get(plan.taskId!).enabled).toBe(true);
  });
});
