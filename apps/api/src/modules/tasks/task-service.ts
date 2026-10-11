import { randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import {
  nextRun,
  parseCron,
  ROLE_PERMISSIONS,
  TASK_PERMISSIONS,
  TASK_TYPES,
  type TaskNotify,
  type TaskOccurrence,
  type TaskRunStatus,
  type TaskRunView,
  type TaskType,
  type TaskView,
} from "@everyos/shared";
import { ApiError, forbidden, notFound } from "../../http/errors.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { NotificationService } from "../notifications/notification-service.ts";
import type { UserRepository } from "../users/user-repository.ts";

export type UserActor = Extract<Actor, { kind: "user" }>;

/** Runs one task action as its owner; the returned summary is shown in the history. */
export type TaskExecutor = (
  params: Record<string, string>,
  actor: UserActor,
  signal: AbortSignal,
) => Promise<{ summary: string | null }>;

interface TaskRow {
  id: string;
  name: string;
  type: TaskType;
  params: string;
  schedule: string;
  enabled: number;
  notify: TaskNotify;
  catch_up: number;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: TaskRunStatus | null;
}

interface RunRow {
  id: string;
  task_id: string;
  trigger: TaskRunView["trigger"];
  status: TaskRunStatus;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  summary: string | null;
}

const TICK_MS = 30_000;
const MAX_CONCURRENT = 2;
/** Missed runs older than this are skipped after a restart. */
const CATCH_UP_WINDOW_MS = 12 * 60 * 60_000;
const RUNS_KEPT = 100;

/**
 * The scheduler (docs/tasks.md). Only predefined actions can be scheduled;
 * each run executes as the task's owner with the owner's *current* role, so a
 * disabled or demoted owner cannot keep privileged tasks running. Runs are
 * independent of HTTP requests, can be cancelled, are recorded and audited,
 * and report to the notification center.
 */
export class TaskService {
  readonly #db: Database;
  readonly #users: UserRepository;
  readonly #audit: AuditLog;
  readonly #notifications: NotificationService;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #executors: Partial<Record<TaskType, TaskExecutor>>;
  readonly #running = new Map<string, AbortController>();
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: {
    db: Database;
    users: UserRepository;
    audit: AuditLog;
    notifications: NotificationService;
    logger: Logger;
    now: () => number;
    executors: Partial<Record<TaskType, TaskExecutor>>;
  }) {
    this.#db = deps.db;
    this.#users = deps.users;
    this.#audit = deps.audit;
    this.#notifications = deps.notifications;
    this.#logger = deps.logger.child({ component: "scheduler" });
    this.#now = deps.now;
    this.#executors = deps.executors;
    this.#db.run(
      "UPDATE task_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
      this.#now(),
    );
  }

  /** Types this server can run (and the caller may create). */
  availableTypes(permissions: ReadonlySet<string>): TaskType[] {
    // In the canonical order, whatever order the executors were registered in.
    return TASK_TYPES.filter(
      (type) => this.#executors[type] !== undefined && permissions.has(TASK_PERMISSIONS[type]),
    );
  }

  /** Starts the clock: catches up missed runs once, then checks every 30 s. */
  start(): void {
    if (this.#timer) return;
    const now = this.#now();
    for (const row of this.#db.all<TaskRow>(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at < ?",
      now,
    )) {
      if (row.catch_up === 1 && now - row.next_run_at! <= CATCH_UP_WINDOW_MS)
        void this.#run(row, "catch-up");
      else this.#reschedule(row.id, row.schedule);
    }
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const controller of this.#running.values()) controller.abort();
  }

  /** Runs due tasks (called by the clock; tests call it directly). */
  tick(): void {
    const due = this.#db.all<TaskRow>(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
      this.#now(),
    );
    for (const row of due) {
      if (this.#running.size >= MAX_CONCURRENT) break;
      if (!this.#running.has(row.id)) void this.#run(row, "schedule");
    }
  }

  list(): TaskView[] {
    return this.#db
      .all<TaskRow>("SELECT * FROM scheduled_tasks ORDER BY name COLLATE NOCASE")
      .map((row) => this.#view(row));
  }

  /**
   * Runs of enabled tasks between `from` and `to`, in the server's local time
   * like the schedules themselves: the first `limit` runs, and the number of
   * runs per day (`YYYY-MM-DD`) for calendar views.
   */
  calendar(
    from: number,
    to: number,
    limit = 200,
  ): { occurrences: TaskOccurrence[]; days: Record<string, number> } {
    const occurrences: TaskOccurrence[] = [];
    const days: Record<string, number> = {};
    const pad = (n: number) => String(n).padStart(2, "0");
    for (const row of this.#db.all<TaskRow>("SELECT * FROM scheduled_tasks WHERE enabled = 1")) {
      const schedule = parseCron(row.schedule);
      if (!schedule) continue;
      let at = nextRun(schedule, from - 1);
      // At most every five minutes: bounded even for a 62-day range.
      for (let n = 0; at !== null && at < to && n < 20_000; n++) {
        const date = new Date(at);
        const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        days[key] = (days[key] ?? 0) + 1;
        if (n < limit) occurrences.push({ taskId: row.id, name: row.name, type: row.type, at });
        at = nextRun(schedule, at);
      }
    }
    occurrences.sort((a, b) => a.at - b.at);
    return { occurrences: occurrences.slice(0, limit), days };
  }

  get(id: string): TaskView {
    return this.#view(this.#row(id));
  }

  runs(id: string, limit = 50): TaskRunView[] {
    this.#row(id);
    return this.#db
      .all<RunRow>(
        "SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
        id,
        limit,
      )
      .map(toRunView);
  }

  create(
    input: {
      name: string;
      type: TaskType;
      params: Record<string, string>;
      schedule: string;
      enabled: boolean;
      notify: TaskNotify;
      catchUp: boolean;
    },
    owner: { id: string; permissions: ReadonlySet<string> },
  ): TaskView {
    this.#authorize(input.type, owner.permissions);
    const id = randomUUID();
    const now = this.#now();
    this.#db.run(
      `INSERT INTO scheduled_tasks(id, name, type, params, schedule, enabled, notify, catch_up, owner_id, created_at, updated_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.type,
      JSON.stringify(input.params),
      input.schedule,
      input.enabled ? 1 : 0,
      input.notify,
      input.catchUp ? 1 : 0,
      owner.id,
      now,
      now,
      nextRun(parseCron(input.schedule)!, now),
    );
    return this.get(id);
  }

  /** Editing a task makes the editor its owner (it then runs with their permissions). */
  update(
    id: string,
    patch: {
      name?: string | undefined;
      schedule?: string | undefined;
      enabled?: boolean | undefined;
      notify?: TaskNotify | undefined;
      catchUp?: boolean | undefined;
    },
    editor: { id: string; permissions: ReadonlySet<string> },
  ): TaskView {
    const row = this.#row(id);
    this.#authorize(row.type, editor.permissions);
    const schedule = patch.schedule ?? row.schedule;
    this.#db.run(
      `UPDATE scheduled_tasks SET name = ?, schedule = ?, enabled = ?, notify = ?, catch_up = ?, owner_id = ?, updated_at = ?, next_run_at = ? WHERE id = ?`,
      patch.name ?? row.name,
      schedule,
      (patch.enabled ?? row.enabled === 1) ? 1 : 0,
      patch.notify ?? row.notify,
      (patch.catchUp ?? row.catch_up === 1) ? 1 : 0,
      editor.id,
      this.#now(),
      nextRun(parseCron(schedule)!, this.#now()),
      id,
    );
    return this.get(id);
  }

  remove(id: string, editor: { permissions: ReadonlySet<string> }): TaskView {
    const view = this.get(id);
    this.#authorize(view.type, editor.permissions);
    this.#running.get(id)?.abort();
    this.#db.run("DELETE FROM scheduled_tasks WHERE id = ?", id);
    return view;
  }

  /** Runs a task now (as its owner), outside the schedule. */
  runNow(id: string, editor: { permissions: ReadonlySet<string> }): TaskRunView {
    const row = this.#row(id);
    this.#authorize(row.type, editor.permissions);
    if (this.#running.has(id)) throw new ApiError(409, "CONFLICT", "The task is already running");
    const runId = randomUUID();
    void this.#run(row, "manual", runId);
    return toRunView(this.#db.get<RunRow>("SELECT * FROM task_runs WHERE id = ?", runId)!);
  }

  cancel(id: string): boolean {
    const controller = this.#running.get(id);
    controller?.abort();
    return Boolean(controller);
  }

  #authorize(type: TaskType, permissions: ReadonlySet<string>): void {
    if (!this.#executors[type])
      throw new ApiError(400, "VALIDATION_FAILED", "This task type is not available");
    if (!permissions.has(TASK_PERMISSIONS[type])) throw forbidden();
  }

  async #run(
    row: TaskRow,
    trigger: TaskRunView["trigger"],
    runId: string = randomUUID(),
  ): Promise<void> {
    const controller = new AbortController();
    this.#running.set(row.id, controller);
    const startedAt = this.#now();
    this.#db.run(
      "INSERT INTO task_runs(id, task_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)",
      runId,
      row.id,
      trigger,
      startedAt,
    );
    // The next scheduled time is computed up front, so a long run is not repeated.
    this.#reschedule(row.id, row.schedule);
    let status: TaskRunStatus = "succeeded";
    let error: string | null = null;
    let summary: string | null = null;
    let actor: UserActor | null = null;
    try {
      actor = this.#owner(row);
      const executor = this.#executors[row.type];
      if (!executor) throw new TaskFailure("unavailable");
      summary = (
        await executor(JSON.parse(row.params) as Record<string, string>, actor, controller.signal)
      ).summary;
      if (controller.signal.aborted) status = "cancelled";
    } catch (caught) {
      status = controller.signal.aborted ? "cancelled" : "failed";
      error =
        caught instanceof TaskFailure
          ? caught.reason
          : ((caught as { code?: string }).code ?? "failed");
      if (status === "failed")
        this.#logger.warn("Scheduled task failed", {
          taskId: row.id,
          type: row.type,
          error: caught,
        });
    } finally {
      this.#running.delete(row.id);
    }
    const finishedAt = this.#now();
    this.#db.transaction(() => {
      this.#db.run(
        "UPDATE task_runs SET status = ?, finished_at = ?, error = ?, summary = ? WHERE id = ?",
        status,
        finishedAt,
        error,
        summary,
        runId,
      );
      this.#db.run(
        "UPDATE scheduled_tasks SET last_run_at = ?, last_status = ? WHERE id = ?",
        startedAt,
        status,
        row.id,
      );
      this.#db.run(
        `DELETE FROM task_runs WHERE task_id = ? AND id NOT IN (
           SELECT id FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?)`,
        row.id,
        row.id,
        RUNS_KEPT,
      );
    });
    this.#audit.record({
      action: "tasks.run",
      outcome: status === "succeeded" ? "success" : "failure",
      ...(actor ? { actor: { userId: actor.userId, username: actor.username } } : {}),
      target: row.name,
      details: {
        taskId: row.id,
        type: row.type,
        trigger,
        status,
        ...(error ? { reason: error } : {}),
      },
    });
    if (status === "failed" && row.notify !== "never")
      this.#notifications.publish({
        kind: "task-failed",
        severity: "warning",
        key: row.id,
        params: { task: row.name, reason: error ?? "failed" },
      });
    else if (status === "succeeded" && row.notify === "always")
      this.#notifications.publish({
        kind: "task-succeeded",
        severity: "success",
        key: row.id,
        params: { task: row.name },
      });
  }

  /** The owner, if they still exist, are enabled and may run this type of task. */
  #owner(row: TaskRow): UserActor {
    const user = row.owner_id ? this.#users.findById(row.owner_id) : null;
    if (!user || user.disabled || !ROLE_PERMISSIONS[user.role].has(TASK_PERMISSIONS[row.type]))
      throw new TaskFailure("owner-unauthorized");
    return {
      kind: "user",
      userId: user.id,
      username: user.username,
      role: user.role,
      ip: "scheduler",
    };
  }

  #reschedule(id: string, schedule: string): void {
    const parsed = parseCron(schedule);
    this.#db.run(
      "UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?",
      parsed ? nextRun(parsed, this.#now()) : null,
      id,
    );
  }

  #row(id: string): TaskRow {
    const row = this.#db.get<TaskRow>("SELECT * FROM scheduled_tasks WHERE id = ?", id);
    if (!row) throw notFound("Task");
    return row;
  }

  #view(row: TaskRow): TaskView {
    const owner = row.owner_id ? this.#users.findById(row.owner_id) : null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      params: JSON.parse(row.params) as Record<string, string>,
      schedule: row.schedule,
      enabled: row.enabled === 1,
      notify: row.notify,
      catchUp: row.catch_up === 1,
      owner: owner?.username ?? null,
      createdAt: row.created_at,
      nextRunAt: row.enabled === 1 ? row.next_run_at : null,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      running: this.#running.has(row.id),
    };
  }
}

/** A failure with a stable, displayable reason code. */
export class TaskFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "TaskFailure";
    this.reason = reason;
  }
}

function toRunView(row: RunRow): TaskRunView {
  return {
    id: row.id,
    taskId: row.task_id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    summary: row.summary,
  };
}
