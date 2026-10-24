import {
  compareKeys,
  daysBetween,
  dueInstant,
  isDateKey,
  todayKey,
  type DateKey,
} from "./dates.ts";
import { isRecurrence, nextOccurrence, type Recurrence } from "./recurrence.ts";

export type Priority = 0 | 1 | 2 | 3;

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  /** null: the Inbox. */
  projectId: string | null;
  title: string;
  notes: string;
  priority: Priority;
  due: DateKey | null;
  /** "HH:MM", only with a due date. */
  dueTime: string | null;
  /** Minutes before the due time to remind (null: no reminder). */
  remind: number | null;
  tags: string[];
  subtasks: Subtask[];
  recurrence: Recurrence | null;
  completedAt: number | null;
  /** When occurrences of a repeating task were completed (latest 100). */
  completions: number[];
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  order: number;
}

export const PROJECT_COLORS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#d97706",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#4b5563",
];
export const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440] as const;

export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(9))]
    .map((byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function normalizeTags(input: string | readonly string[]): string[] {
  const list = typeof input === "string" ? input.split(/[\s,]+/) : input;
  return [
    ...new Set(
      list
        .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
        .filter((tag) => /^[\p{L}\p{N}_-]{1,32}$/u.test(tag)),
    ),
  ].slice(0, 20);
}

/** A quick-add line: "#tags" become tags, the rest is the title. */
export function parseQuickAdd(text: string): { title: string; tags: string[] } {
  const tags = normalizeTags(
    (text.match(/(^|\s)#[\p{L}\p{N}_-]+/gu) ?? []).map((tag) => tag.trim()),
  );
  const title = text
    .replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title.slice(0, 500), tags };
}

export function createTask(input: Partial<Task> & { title: string }, now: number): Task {
  return {
    id: newId(),
    projectId: input.projectId ?? null,
    title: input.title.slice(0, 500),
    notes: input.notes ?? "",
    priority: input.priority ?? 0,
    due: input.due ?? null,
    dueTime: input.due ? (input.dueTime ?? null) : null,
    remind: input.remind ?? null,
    tags: normalizeTags(input.tags ?? []),
    subtasks: input.subtasks ?? [],
    recurrence: input.recurrence ?? null,
    completedAt: null,
    completions: [],
    order: input.order ?? now,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Completes a task. A repeating task records the completion and moves to its next occurrence
 * (subtasks open again); others are done.
 */
export function complete(task: Task, now: number): Task {
  if (task.recurrence) {
    const base = task.due ?? todayKey(now);
    return {
      ...task,
      due: nextOccurrence(task.recurrence, base),
      subtasks: task.subtasks.map((subtask) => ({ ...subtask, done: false })),
      completions: [...task.completions, now].slice(-100),
      updatedAt: now,
    };
  }
  return { ...task, completedAt: now, updatedAt: now };
}

export function reopen(task: Task, now: number): Task {
  return { ...task, completedAt: null, updatedAt: now };
}

export type SmartList = "inbox" | "today" | "upcoming" | "overdue" | "all" | "completed";

export function isOverdue(task: Task, today: DateKey): boolean {
  return task.completedAt === null && task.due !== null && compareKeys(task.due, today) < 0;
}

export function inList(task: Task, list: SmartList, today: DateKey): boolean {
  if (list === "completed") return task.completedAt !== null;
  if (task.completedAt !== null) return false;
  switch (list) {
    case "inbox":
      return task.projectId === null;
    case "today":
      return task.due !== null && compareKeys(task.due, today) <= 0;
    case "upcoming":
      return (
        task.due !== null && daysBetween(today, task.due) >= 1 && daysBetween(today, task.due) <= 7
      );
    case "overdue":
      return isOverdue(task, today);
    case "all":
      return true;
  }
}

export function matches(task: Task, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const tag = needle.replace(/^#/, "");
  return (
    task.title.toLowerCase().includes(needle) ||
    task.notes.toLowerCase().includes(needle) ||
    task.tags.some((name) => name.includes(tag)) ||
    task.subtasks.some((subtask) => subtask.title.toLowerCase().includes(needle))
  );
}

export type SortOrder = "manual" | "due" | "priority" | "title";

export function sortTasks(tasks: Task[], order: SortOrder, locale: string): Task[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const byDue = (a: Task, b: Task) =>
    (a.due ?? "9999") === (b.due ?? "9999")
      ? (a.dueTime ?? "99") < (b.dueTime ?? "99")
        ? -1
        : (a.dueTime ?? "99") > (b.dueTime ?? "99")
          ? 1
          : 0
      : (a.due ?? "9999") < (b.due ?? "9999")
        ? -1
        : 1;
  const compare: Record<SortOrder, (a: Task, b: Task) => number> = {
    manual: (a, b) => a.order - b.order,
    due: (a, b) => byDue(a, b) || b.priority - a.priority || a.order - b.order,
    priority: (a, b) => b.priority - a.priority || byDue(a, b) || a.order - b.order,
    title: (a, b) => collator.compare(a.title, b.title),
  };
  return [...tasks].sort(compare[order]);
}

/** When a task's reminder is due (null: none). */
export function reminderAt(task: Task): number | null {
  if (task.completedAt !== null || task.remind === null || !task.due) return null;
  return dueInstant(task.due, task.dueTime) - task.remind * 60_000;
}

/** The key that makes a reminder fire once per occurrence. */
export function reminderKey(task: Task): string {
  return `${task.id}:${task.due}:${task.dueTime ?? ""}:${task.remind}`;
}

/** Reminders that are due by `now` and not older than a day (sent once each). */
export function dueReminders(
  tasks: readonly Task[],
  sent: ReadonlySet<string>,
  now: number,
): Task[] {
  return tasks.filter((task) => {
    const at = reminderAt(task);
    return at !== null && at <= now && now - at < 86_400_000 && !sent.has(reminderKey(task));
  });
}

/** Checks what came from storage or a backup; returns null for anything that is not a task. */
export function parseTask(value: unknown): Task | null {
  const task = value as Partial<Task> | null;
  if (!task || typeof task.id !== "string" || !/^[a-z0-9]{4,32}$/.test(task.id)) return null;
  if (typeof task.title !== "string") return null;
  const priority = [0, 1, 2, 3].includes(task.priority as number) ? (task.priority as Priority) : 0;
  const due = isDateKey(task.due) ? task.due : null;
  return {
    id: task.id,
    projectId: typeof task.projectId === "string" ? task.projectId : null,
    title: task.title.slice(0, 500),
    notes: typeof task.notes === "string" ? task.notes.slice(0, 20_000) : "",
    priority,
    due,
    dueTime:
      due && typeof task.dueTime === "string" && /^\d{2}:\d{2}$/.test(task.dueTime)
        ? task.dueTime
        : null,
    remind: typeof task.remind === "number" && task.remind >= 0 ? task.remind : null,
    tags: normalizeTags(
      Array.isArray(task.tags) ? task.tags.filter((tag) => typeof tag === "string") : [],
    ),
    subtasks: Array.isArray(task.subtasks)
      ? task.subtasks
          .filter((subtask): subtask is Subtask => !!subtask && typeof subtask.title === "string")
          .map((subtask) => ({
            id: typeof subtask.id === "string" ? subtask.id : newId(),
            title: subtask.title.slice(0, 500),
            done: subtask.done === true,
          }))
      : [],
    recurrence: isRecurrence(task.recurrence) ? task.recurrence : null,
    completedAt: typeof task.completedAt === "number" ? task.completedAt : null,
    completions: Array.isArray(task.completions)
      ? task.completions.filter((at) => typeof at === "number").slice(-100)
      : [],
    order: typeof task.order === "number" ? task.order : 0,
    createdAt: typeof task.createdAt === "number" ? task.createdAt : 0,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : 0,
  };
}
