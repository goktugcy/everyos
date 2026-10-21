import { EmptyState, useApp, useT } from "@everyos/app-ui";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { todayKey } from "./dates.ts";
import { complete, createTask, inList, parseQuickAdd, sortTasks } from "./model.ts";
import { useDueLabel } from "./task-row.tsx";
import { useReminders, useTodo } from "./use-todo.ts";

/** Today's and overdue tasks: check them off, add one, open one in the app. */
export function TaskWidget() {
  const app = useApp();
  const t = useT();
  const todo = useTodo();
  useReminders(todo.tasks, "widget");
  const dueLabel = useDueLabel();
  const [text, setText] = useState("");
  const today = todayKey();
  const tasks = sortTasks(
    (todo.tasks ?? []).filter((task) => inList(task, "today", today)),
    "due",
    "en",
  );
  const add = async () => {
    const { title, tags } = parseQuickAdd(text);
    if (!title) return;
    setText("");
    await todo.save(createTask({ title, tags, due: today }, Date.now()));
  };
  return (
    <div className="todo-widget">
      <div className="todo-widget-head">
        <strong>{t("lists.today")}</strong>
        <span className="todo-count">{tasks.length}</span>
      </div>
      {todo.tasks && !tasks.length ? (
        <EmptyState icon={<CheckCircle2 size={22} aria-hidden />} title={t("empty.today")} />
      ) : (
        <ul className="todo-widget-list">
          {tasks.slice(0, 12).map((task) => (
            <li key={task.id}>
              <input
                type="checkbox"
                className="todo-check"
                data-priority={task.priority}
                aria-label={t("task.completeNamed", { name: task.title })}
                checked={false}
                onChange={() =>
                  void todo.change(task.id, (current) => complete(current, Date.now()))
                }
              />
              <button type="button" onClick={() => void app.window.open({ taskId: task.id })}>
                <span>{task.title}</span>
                {task.due && task.due < today ? (
                  <span className="todo-due" data-overdue>
                    {dueLabel(task.due, today, task.dueTime)}
                  </span>
                ) : task.dueTime ? (
                  <span className="todo-due">{task.dueTime}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="todo-quick"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          className="eui-input"
          aria-label={t("task.quickAdd")}
          placeholder={t("widget.add")}
          value={text}
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
        />
      </form>
    </div>
  );
}
