import { IconButton, useI18n, useT } from "@everyos/app-ui";
import { ArrowDown, ArrowUp, Flag, ListChecks, Repeat, Trash2 } from "lucide-react";
import { daysBetween, fromKey, type DateKey } from "./dates.ts";
import type { Project, Task } from "./model.ts";

/** "Today", "Tomorrow", "Yesterday", a weekday within a week, or the date. */
export function useDueLabel() {
  const t = useT();
  const i18n = useI18n();
  return (due: DateKey, today: DateKey, time: string | null) => {
    const days = daysBetween(today, due);
    const day =
      days === 0
        ? t("due.today")
        : days === 1
          ? t("due.tomorrow")
          : days === -1
            ? t("due.yesterday")
            : days > 1 && days < 7
              ? i18n.date(fromKey(due), { weekday: "long" })
              : i18n.date(fromKey(due), {
                  day: "numeric",
                  month: "short",
                  year: days > 300 || days < -300 ? "numeric" : undefined,
                });
    return time ? `${day} ${time}` : day;
  };
}

export function TaskRow({
  task,
  project,
  today,
  selected,
  onSelect,
  onToggle,
  onMove,
  onDelete,
}: {
  task: Task;
  project: Project | null;
  today: DateKey;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMove: (step: -1 | 1) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const dueLabel = useDueLabel();
  const done = task.completedAt !== null;
  const overdue = !done && task.due !== null && task.due < today;
  const subtasksDone = task.subtasks.filter((subtask) => subtask.done).length;
  return (
    <li
      className="todo-row"
      aria-current={selected ? "true" : undefined}
      data-done={done || undefined}
    >
      <input
        type="checkbox"
        className="todo-check"
        data-priority={task.priority}
        checked={done}
        aria-label={done ? t("task.reopen") : t("task.complete")}
        onChange={onToggle}
      />
      <button
        type="button"
        className="todo-row-main"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          } else if (event.key === "Delete") {
            event.preventDefault();
            onDelete();
          } else if (event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="todo-row-title">{task.title}</span>
        <span className="todo-row-meta">
          {task.due ? (
            <span className="todo-due" data-overdue={overdue || undefined}>
              {dueLabel(task.due, today, task.dueTime)}
            </span>
          ) : null}
          {task.recurrence ? <Repeat size={12} aria-label={t("recurrence.repeats")} /> : null}
          {task.priority ? (
            <span className="todo-flag" data-priority={task.priority}>
              <Flag size={12} aria-hidden />
              {t(`priority.${task.priority}`)}
            </span>
          ) : null}
          {task.subtasks.length ? (
            <span>
              <ListChecks size={12} aria-hidden /> {subtasksDone}/{task.subtasks.length}
            </span>
          ) : null}
          {project ? (
            <span className="todo-project">
              <span className="todo-dot" style={{ background: project.color }} aria-hidden />
              {project.name}
            </span>
          ) : null}
          {task.tags.map((tag) => (
            <span key={tag} className="todo-tag">
              #{tag}
            </span>
          ))}
        </span>
      </button>
      <span className="todo-row-tools">
        <IconButton
          size="sm"
          label={t("task.moveUp")}
          icon={<ArrowUp size={14} aria-hidden />}
          onClick={() => onMove(-1)}
        />
        <IconButton
          size="sm"
          label={t("task.moveDown")}
          icon={<ArrowDown size={14} aria-hidden />}
          onClick={() => onMove(1)}
        />
        <IconButton
          size="sm"
          label={t("ui.delete")}
          icon={<Trash2 size={14} aria-hidden />}
          onClick={onDelete}
        />
      </span>
    </li>
  );
}
