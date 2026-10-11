import type { Permission } from "./permissions.ts";

/*
 * Scheduled tasks (docs/tasks.md): only these predefined, parameterized
 * actions can be scheduled — never arbitrary commands.
 */

export const TASK_TYPES = [
  "updates.refresh",
  "updates.security",
  "service.restart",
  "container.restart",
  "app.update",
  "backup.create",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Permission the task owner needs (when creating it and every time it runs). */
export const TASK_PERMISSIONS: Record<TaskType, Permission> = {
  "updates.refresh": "system:manage",
  "updates.security": "system:manage",
  "service.restart": "services:manage",
  "container.restart": "docker:manage",
  "app.update": "apps:manage",
  "backup.create": "backups:manage",
};

export type TaskNotify = "failure" | "always" | "never";

export type TaskRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface TaskView {
  id: string;
  name: string;
  type: TaskType;
  params: Record<string, string>;
  /** Cron expression in the server's local time. */
  schedule: string;
  enabled: boolean;
  notify: TaskNotify;
  /** Run once after a restart if a scheduled run was missed (within 12 hours). */
  catchUp: boolean;
  owner: string | null;
  createdAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: TaskRunStatus | null;
  running: boolean;
}

export interface TaskRunView {
  id: string;
  taskId: string;
  trigger: "schedule" | "manual" | "catch-up";
  status: TaskRunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Short result, e.g. "3 packages upgraded". */
  summary: string | null;
}

/** One upcoming run of an enabled task (the pulse calendar). */
export interface TaskOccurrence {
  taskId: string;
  name: string;
  type: TaskType;
  at: number;
}
