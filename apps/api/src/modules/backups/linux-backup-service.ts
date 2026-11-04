import { randomUUID } from "node:crypto";
import type { Database } from "@everyos/database";
import type { OperationParams, OperationResult, UnaryOperationName } from "@everyos/agent-protocol";
import { toApiError, type UserActor } from "../../http/agent.ts";
import type { SecretBox } from "@everyos/security";
import {
  linuxBackupCron,
  ROLE_PERMISSIONS,
  type LinuxBackupPlan,
  type LinuxBackupJob,
  type LinuxBackupOverview,
  type LinuxBackupInstallation,
} from "@everyos/shared";
import type { LinuxBackupPlanRequestSchema } from "@everyos/shared/schemas";
import type { z } from "zod";
import type { AgentGateway } from "../../services.ts";
import { ApiError } from "../../http/errors.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { TaskService } from "../tasks/task-service.ts";

type Draft = z.infer<typeof LinuxBackupPlanRequestSchema>;
type Stored = Omit<LinuxBackupPlan, "nextRunAt" | "scheduleOverride"> & {
  sealedPassphrase: string | null;
};
const PLANS = "linux-backup/plans/v1";
const CURRENT = "linux-backup/job/v1";
const OWNER = "linux-backup/actor/v1";
const HISTORY = "linux-backup/history/v1";
const INSTALLATION = "linux-backup/installation/v1";
const context = (id: string) => `everyos/linux-backup/${id}/passphrase`;
const wait = (signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(finish, 1000);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    if (!signal.aborted) signal.addEventListener("abort", finish, { once: true });
  });

/** Linux repository credentials are sealed; jobs and schedules never contain a passphrase. */
export class LinuxBackupService {
  readonly #db: Database;
  readonly #agent: AgentGateway;
  readonly #secrets: SecretBox;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  #tasks: TaskService | null = null;
  #refreshing: Promise<LinuxBackupJob | null> | null = null;
  #starting = false;
  #timer: NodeJS.Timeout | null = null;
  #installController: AbortController | null = null;
  #installExecution: Promise<void> | null = null;
  #stopping = false;

  constructor(deps: {
    db: Database;
    agent: AgentGateway;
    secrets: SecretBox;
    audit: AuditLog;
    now: () => number;
  }) {
    this.#db = deps.db;
    this.#agent = deps.agent;
    this.#secrets = deps.secrets;
    this.#audit = deps.audit;
    this.#now = deps.now;
    const previous = this.#read<LinuxBackupInstallation | null>(INSTALLATION, null);
    if (previous?.status === "running")
      this.#write(INSTALLATION, {
        ...previous,
        status: "failed",
        stage: "done",
        finishedAt: this.#now(),
        error: "BORG_INSTALL_INTERRUPTED",
      });
  }
  async #call<N extends UnaryOperationName>(
    op: N,
    params: OperationParams<N>,
    actor: UserActor,
  ): Promise<OperationResult<N>> {
    try {
      return await this.#agent.call(op, params, actor);
    } catch (error) {
      throw toApiError(error);
    }
  }
  attachTasks(tasks: TaskService) {
    this.#tasks = tasks;
  }
  startPolling() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      const actor = this.#read<UserActor | null>(OWNER, null);
      if (actor && this.#read<LinuxBackupJob | null>(CURRENT, null))
        void this.refresh(actor).catch(() => undefined);
    }, 1000);
    this.#timer.unref();
  }
  async stop() {
    this.#stopping = true;
    this.#installController?.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#installExecution;
    await this.#refreshing;
  }
  #read<T>(key: string, fallback: T): T {
    const row = this.#db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      key,
    );
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  #write(key: string, value: unknown) {
    this.#db.run(
      "INSERT INTO instance_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      key,
      JSON.stringify(value),
      this.#now(),
    );
  }
  #authorize(actor: UserActor) {
    if (!ROLE_PERMISSIONS[actor.role].has("backups:restore"))
      throw new ApiError(403, "FORBIDDEN", "Linux backups require administrator backup permission");
  }
  #plans() {
    return this.#read<Stored[]>(PLANS, []);
  }
  #plan(id: string) {
    const plan = this.#plans().find((p) => p.id === id);
    if (!plan) throw new ApiError(404, "NOT_FOUND", "Linux backup plan not found");
    return plan;
  }
  #view(plan: Stored): LinuxBackupPlan {
    const { sealedPassphrase: _secret, ...rest } = plan;
    let nextRunAt: number | null = null;
    const schedule = { ...plan.schedule };
    let scheduleOverride: string | null = null;
    if (plan.taskId) {
      try {
        const task = this.#tasks?.get(plan.taskId);
        nextRunAt = task?.nextRunAt ?? null;
        if (!task?.enabled) schedule.frequency = "manual";
        else if (task.schedule !== linuxBackupCron(plan.schedule)) scheduleOverride = task.schedule;
      } catch {
        schedule.frequency = "manual";
      }
    }
    return { ...rest, schedule, scheduleOverride, nextRunAt };
  }
  #spec(plan: Stored): OperationParams<"backups.linux.start">["spec"] {
    const {
      id,
      targetId,
      targetDevice,
      encryption,
      compression,
      scope,
      includes,
      excludes,
      excludeCaches,
      retention,
    } = plan;
    return {
      planId: id,
      targetId,
      targetDevice,
      encryption,
      compression,
      scope,
      includes,
      excludes,
      excludeCaches,
      retention,
      passphrase: plan.sealedPassphrase
        ? this.#secrets.open(plan.sealedPassphrase, context(id))
        : "",
    };
  }
  #record(
    actor: UserActor,
    action: string,
    target: string,
    details: Record<string, unknown> = {},
    outcome: "success" | "failure" = "success",
  ) {
    this.#audit.record({
      action: `backups.linux.${action}`,
      outcome,
      actor: { userId: actor.userId, username: actor.username },
      ip: actor.ip ?? null,
      target,
      details,
    });
  }

  async overview(actor: UserActor): Promise<LinuxBackupOverview> {
    this.#authorize(actor);
    const capability = await this.#call("backups.linux.status", {}, actor);
    const job = await this.refresh(actor);
    return {
      capability,
      installation: this.#read<LinuxBackupInstallation | null>(INSTALLATION, null),
      plans: this.#plans().map((p) => this.#view(p)),
      job: job?.status === "running" ? job : null,
      history: this.#read<LinuxBackupJob[]>(HISTORY, []),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async installEngine(actor: UserActor): Promise<LinuxBackupInstallation> {
    this.#authorize(actor);
    if (this.#stopping)
      throw new ApiError(503, "AGENT_UNAVAILABLE", "Linux backup service is stopping");
    if (!ROLE_PERMISSIONS[actor.role].has("system:manage"))
      throw new ApiError(
        403,
        "FORBIDDEN",
        "System package installation requires administrator permission",
      );
    if (this.#starting || this.#installController)
      throw new ApiError(409, "BACKUP_BUSY", "Linux backup operation is running");
    this.#starting = true;
    try {
      if ((await this.refresh(actor))?.status === "running")
        throw new ApiError(409, "BACKUP_BUSY", "Linux backup is running");
      const capability = await this.#call("backups.linux.status", {}, actor);
      if (this.#stopping)
        throw new ApiError(503, "AGENT_UNAVAILABLE", "Linux backup service is stopping");
      if (capability.reason !== "borg-missing" || !capability.installationSupported)
        throw new ApiError(
          409,
          "HOST_CAPABILITY_UNAVAILABLE",
          "BorgBackup installation is unavailable on this host",
        );
      const job: LinuxBackupInstallation = {
        id: randomUUID(),
        status: "running",
        stage: "preparing",
        startedAt: this.#now(),
        finishedAt: null,
        error: null,
      };
      this.#write(INSTALLATION, job);
      this.#record(actor, "engine.install.start", "borgbackup", { jobId: job.id });
      const controller = new AbortController();
      this.#installController = controller;
      this.#installExecution = this.#installEngine(job, actor, controller.signal).finally(() => {
        this.#installController = null;
      });
      return { ...job };
    } finally {
      this.#starting = false;
    }
  }

  async #installEngine(job: LinuxBackupInstallation, actor: UserActor, signal: AbortSignal) {
    let succeeded = false;
    let error = "BORG_INSTALL_FAILED";
    try {
      for await (const event of this.#agent.stream("backups.linux.install", {}, actor, {
        signal,
      })) {
        if (event.type === "stage") {
          job.stage = event.stage;
          this.#write(INSTALLATION, job);
        } else {
          succeeded = event.ok;
          error = event.error ?? "BORG_INSTALL_FAILED";
        }
      }
    } catch (caught) {
      succeeded = false;
      const failure = toApiError(caught);
      const reason = (failure.details as { reason?: string } | undefined)?.reason?.split(":")[0];
      error = reason && /^[A-Z_]{1,128}$/.test(reason) ? reason : failure.code;
    } finally {
      job.status = succeeded && !signal.aborted ? "succeeded" : "failed";
      job.stage = "done";
      job.finishedAt = this.#now();
      job.error =
        job.status === "succeeded" ? null : signal.aborted ? "BORG_INSTALL_INTERRUPTED" : error;
      this.#write(INSTALLATION, job);
      this.#record(
        actor,
        "engine.install.finish",
        "borgbackup",
        { jobId: job.id, status: job.status, error: job.error },
        job.status === "succeeded" ? "success" : "failure",
      );
    }
  }

  async save(draft: Draft, actor: UserActor, id?: string): Promise<LinuxBackupPlan> {
    this.#authorize(actor);
    if (this.#starting || this.#installController)
      throw new ApiError(409, "BACKUP_BUSY", "Linux backup operation is running");
    this.#starting = true;
    try {
      if ((await this.refresh(actor))?.status === "running")
        throw new ApiError(409, "BACKUP_BUSY", "Linux backup is running");
      return await this.#save(draft, actor, id);
    } finally {
      this.#starting = false;
    }
  }
  async #save(draft: Draft, actor: UserActor, id?: string): Promise<LinuxBackupPlan> {
    const capability = await this.#call("backups.linux.status", {}, actor);
    if (!capability.available)
      throw new ApiError(503, "HOST_CAPABILITY_UNAVAILABLE", "Linux backups are unavailable", {
        details: { reason: capability.reason },
      });
    const target = capability.targets.find((p) => p.id === draft.targetId && p.available);
    if (!target) throw new ApiError(400, "VALIDATION_FAILED", "Backup destination is unavailable");
    const previous = id ? this.#plan(id) : null;
    if (
      previous &&
      (previous.encryption !== draft.encryption ||
        previous.targetId !== draft.targetId ||
        previous.targetDevice !== target.device)
    )
      throw new ApiError(
        400,
        "VALIDATION_FAILED",
        "A new destination or encryption mode requires a new plan",
      );
    if (draft.encryption === "repokey-blake2" && !previous && !draft.passphrase)
      throw new ApiError(400, "VALIDATION_FAILED", "A backup passphrase is required");
    if (draft.encryption === "none" && draft.passphrase)
      throw new ApiError(400, "VALIDATION_FAILED", "Unencrypted plans do not use a passphrase");
    if (previous && draft.passphrase && draft.passphrase !== this.#spec(previous).passphrase)
      throw new ApiError(
        400,
        "VALIDATION_FAILED",
        "Existing repository passphrases cannot be changed through plan editing",
      );
    const planId = previous?.id ?? randomUUID();
    const {
      password: _password,
      passphrase: _passphrase,
      unencryptedConsent: _consent,
      ...data
    } = draft;
    const plan: Stored = {
      ...data,
      id: planId,
      targetDevice: target.device,
      targetPath: target.path,
      createdAt: previous?.createdAt ?? this.#now(),
      taskId: previous?.taskId ?? null,
      sealedPassphrase:
        previous?.sealedPassphrase ??
        (draft.passphrase ? this.#secrets.seal(draft.passphrase, context(planId)) : null),
    };
    if (!this.#tasks) throw new Error("Linux backup task service is not attached");
    const owner = { id: actor.userId, permissions: ROLE_PERMISSIONS[actor.role] };
    const cron = linuxBackupCron(plan.schedule);
    this.#db.transaction(() => {
      if (plan.taskId) {
        try {
          this.#tasks!.get(plan.taskId);
        } catch {
          plan.taskId = null;
        }
      }
      if (cron) {
        if (plan.taskId)
          this.#tasks!.update(
            plan.taskId,
            { name: plan.name, schedule: cron, enabled: true },
            owner,
          );
        else
          plan.taskId = this.#tasks!.create(
            {
              name: plan.name,
              type: "backup.linux",
              params: { planId },
              schedule: cron,
              enabled: true,
              notify: "failure",
              catchUp: true,
            },
            owner,
          ).id;
      } else if (plan.taskId) {
        this.#tasks!.remove(plan.taskId, owner);
        plan.taskId = null;
      }
      this.#write(PLANS, [...this.#plans().filter((p) => p.id !== planId), plan]);
    });
    this.#record(actor, previous ? "plan.update" : "plan.create", planId, {
      scope: plan.scope,
      encryption: plan.encryption,
      frequency: plan.schedule.frequency,
      retention: plan.retention.enabled,
    });
    return this.#view(plan);
  }

  async archives(id: string, actor: UserActor) {
    this.#authorize(actor);
    try {
      return await this.#call(
        "backups.linux.archives",
        { spec: this.#spec(this.#plan(id)) },
        actor,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { archives: [], limit: 1000 };
      throw error;
    }
  }

  async start(
    id: string,
    kind: LinuxBackupJob["kind"],
    archive: string | null,
    actor: UserActor,
  ): Promise<LinuxBackupJob> {
    this.#authorize(actor);
    if (this.#starting || this.#installController)
      throw new ApiError(409, "BACKUP_BUSY", "Linux backup operation is running");
    this.#starting = true;
    try {
      if ((await this.refresh(actor))?.status === "running")
        throw new ApiError(409, "BACKUP_BUSY", "Linux backup is running");
      const job = await this.#call(
        "backups.linux.start",
        { spec: this.#spec(this.#plan(id)), kind, archive },
        actor,
      );
      this.#write(CURRENT, job);
      this.#write(OWNER, {
        kind: "user",
        userId: actor.userId,
        username: actor.username,
        role: actor.role,
        ...(actor.ip ? { ip: actor.ip } : {}),
      });
      this.#record(actor, `${kind}.start`, id, { jobId: job.id, archive });
      return job;
    } finally {
      this.#starting = false;
    }
  }

  refresh(actor: UserActor): Promise<LinuxBackupJob | null> {
    this.#authorize(actor);
    this.#refreshing ??= this.#refresh(actor).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }
  async #refresh(actor: UserActor): Promise<LinuxBackupJob | null> {
    const current = this.#read<LinuxBackupJob | null>(CURRENT, null);
    if (!current) return null;
    let job: LinuxBackupJob;
    try {
      job = await this.#call("backups.linux.job", { id: current.id }, actor);
    } catch (error) {
      if (
        (error as { agentCode?: string; code?: string }).agentCode !== "not_found" &&
        (error as { code?: string }).code !== "not_found" &&
        !(error instanceof ApiError && error.status === 404)
      )
        throw error;
      job = {
        ...current,
        status: "failed",
        error: "BORG_AGENT_RESTARTED",
        finishedAt: this.#now(),
        stage: "done",
      };
    }
    if (job.status === "running") this.#write(CURRENT, job);
    else {
      this.#db.transaction(() => {
        this.#write(CURRENT, null);
        this.#write(
          HISTORY,
          [job, ...this.#read<LinuxBackupJob[]>(HISTORY, []).filter((j) => j.id !== job.id)].slice(
            0,
            100,
          ),
        );
      });
      this.#record(
        actor,
        `${job.kind}.finish`,
        job.planId,
        { jobId: job.id, status: job.status, bytes: job.bytes, files: job.files, error: job.error },
        job.status === "succeeded" ? "success" : "failure",
      );
    }
    return job;
  }

  async wait(id: string, actor: UserActor, signal: AbortSignal): Promise<LinuxBackupJob> {
    for (;;) {
      const job =
        (await this.refresh(actor)) ??
        this.#read<LinuxBackupJob[]>(HISTORY, []).find((j) => j.id === id);
      if (!job || job.id !== id) throw new Error("BORG_JOB_MISSING");
      if (job.status !== "running") return job;
      if (signal.aborted) {
        await this.#call("backups.linux.cancel", { id }, actor);
      }
      await wait(signal);
    }
  }
  async cancel(actor: UserActor) {
    this.#authorize(actor);
    const job = this.#read<LinuxBackupJob | null>(CURRENT, null);
    if (!job) return { cancelled: false };
    const result = await this.#call("backups.linux.cancel", { id: job.id }, actor);
    this.#record(actor, "cancel", job.planId, { jobId: job.id });
    return result;
  }
}
