import {
  Button,
  Checkbox,
  IconButton,
  Select,
  TextArea,
  TextField,
  useI18n,
  useT,
} from "@everyos/app-ui";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { fromKey, todayKey } from "./dates.ts";
import {
  newId,
  normalizeTags,
  REMINDER_OPTIONS,
  type Priority,
  type Project,
  type Task,
} from "./model.ts";
import { makeRecurrence, nextOccurrence, type Recurrence } from "./recurrence.ts";

const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** A text field that saves when it loses focus or Enter is pressed (not on every key). */
function useDraft(value: string, save: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return {
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => {
      if (draft !== value) save(draft);
    },
  };
}

export function TaskDetail({
  task,
  projects,
  onChange,
  onToggle,
  onDelete,
  onClose,
}: {
  task: Task;
  projects: readonly Project[];
  onChange: (update: (task: Task) => Task) => void;
  onToggle: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const set = (patch: Partial<Task>) => onChange((current) => ({ ...current, ...patch }));
  const title = useDraft(
    task.title,
    (value) => value.trim() && set({ title: value.trim().slice(0, 500) }),
  );
  const notes = useDraft(task.notes, (value) => set({ notes: value.slice(0, 20_000) }));
  const tags = useDraft(task.tags.join(", "), (value) => set({ tags: normalizeTags(value) }));
  const [newSubtask, setNewSubtask] = useState("");
  const done = task.completedAt !== null;
  const rule = task.recurrence;

  const setRule = (patch: Partial<Recurrence> | null) => {
    if (patch === null) return set({ recurrence: null });
    const anchor = task.due ?? todayKey();
    const base = rule ?? makeRecurrence("week", anchor);
    set({
      recurrence: makeRecurrence(patch.unit ?? base.unit, patch.anchor ?? base.anchor, {
        interval: patch.interval ?? base.interval,
        weekdays: patch.weekdays ?? base.weekdays,
        monthMode: patch.monthMode ?? base.monthMode,
      }),
      ...(task.due ? {} : { due: anchor }),
    });
  };

  const subtasks = task.subtasks;
  const moveSubtask = (index: number, step: -1 | 1) => {
    const target = index + step;
    if (target < 0 || target >= subtasks.length) return;
    const next = [...subtasks];
    [next[index], next[target]] = [next[target]!, next[index]!];
    set({ subtasks: next });
  };

  return (
    <aside className="todo-detail" aria-label={t("task.details")}>
      <div className="todo-detail-head">
        <Checkbox
          label={done ? t("task.done") : t("task.complete")}
          checked={done}
          onChange={onToggle}
        />
        <span className="eui-spacer" />
        <IconButton
          label={t("ui.delete")}
          icon={<Trash2 size={16} aria-hidden />}
          onClick={onDelete}
        />
        <IconButton label={t("ui.close")} icon={<X size={16} aria-hidden />} onClick={onClose} />
      </div>
      <div className="todo-detail-body">
        <TextField label={t("task.title")} maxLength={500} {...title} />
        <div className="todo-grid">
          <Select<string>
            label={t("task.project")}
            value={task.projectId ?? ""}
            options={[
              { value: "", label: t("lists.inbox") },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            onChange={(projectId) => set({ projectId: projectId || null })}
          />
          <Select<string>
            label={t("task.priority")}
            value={String(task.priority)}
            options={[0, 1, 2, 3].map((value) => ({
              value: String(value),
              label: t(`priority.${value}`),
            }))}
            onChange={(value) => set({ priority: Number(value) as Priority })}
          />
          <TextField
            label={t("task.due")}
            type="date"
            value={task.due ?? ""}
            onChange={(event) => {
              const due = event.target.value || null;
              set({
                due,
                dueTime: due ? task.dueTime : null,
                ...(rule && due ? { recurrence: { ...rule, anchor: due } } : {}),
              });
            }}
          />
          <TextField
            label={t("task.time")}
            type="time"
            value={task.dueTime ?? ""}
            disabled={!task.due}
            onChange={(event) => set({ dueTime: event.target.value || null })}
          />
          <Select<string>
            label={t("task.reminder")}
            value={task.remind === null ? "" : String(task.remind)}
            options={[
              { value: "", label: t("reminder.none") },
              ...REMINDER_OPTIONS.map((minutes) => ({
                value: String(minutes),
                label: t(`reminder.options.${minutes}`),
              })),
            ]}
            onChange={(value) => set({ remind: value === "" ? null : Number(value) })}
          />
        </div>
        {task.remind !== null && !task.due ? (
          <p className="eui-hint">{t("reminder.needsDue")}</p>
        ) : null}

        <fieldset className="todo-repeat">
          <legend>{t("recurrence.title")}</legend>
          <div className="todo-grid">
            <Select<string>
              label={t("recurrence.repeat")}
              value={rule?.unit ?? "none"}
              options={["none", "day", "weekday", "week", "month", "year"].map((value) => ({
                value,
                label: t(`recurrence.units.${value}`),
              }))}
              onChange={(value) =>
                setRule(value === "none" ? null : { unit: value as Recurrence["unit"] })
              }
            />
            {rule && rule.unit !== "weekday" ? (
              <TextField
                label={t(`recurrence.every.${rule.unit}`)}
                type="number"
                min={1}
                max={365}
                value={rule.interval}
                onChange={(event) => {
                  const interval = Number(event.target.value);
                  if (interval >= 1) setRule({ interval });
                }}
              />
            ) : null}
            {rule?.unit === "month" ? (
              <Select<string>
                label={t("recurrence.monthMode")}
                value={rule.monthMode}
                options={[
                  {
                    value: "day",
                    label: t("recurrence.monthDay", { day: fromKey(rule.anchor).getDate() }),
                  },
                  {
                    value: "weekday",
                    label: t("recurrence.monthWeekday", {
                      weekday: i18n.date(fromKey(rule.anchor), { weekday: "long" }),
                    }),
                  },
                ]}
                onChange={(monthMode) =>
                  setRule({ monthMode: monthMode as Recurrence["monthMode"] })
                }
              />
            ) : null}
          </div>
          {rule?.unit === "week" ? (
            <div className="todo-weekdays" role="group" aria-label={t("recurrence.weekdays")}>
              {WEEK.map((day) => {
                const on = rule.weekdays.includes(day);
                // 2024-01-07 was a Sunday: + day gives that weekday's name.
                const name = i18n.date(new Date(2024, 0, 7 + day), { weekday: "short" });
                return (
                  <button
                    key={day}
                    type="button"
                    className="todo-weekday"
                    aria-pressed={on}
                    onClick={() =>
                      setRule({
                        weekdays: on
                          ? rule.weekdays.filter((entry) => entry !== day)
                          : [...rule.weekdays, day],
                      })
                    }
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          ) : null}
          {rule && task.due ? (
            <p className="eui-hint">
              {t("recurrence.next", {
                date: i18n.date(fromKey(nextOccurrence(rule, task.due)), { dateStyle: "full" }),
              })}
            </p>
          ) : null}
        </fieldset>

        <TextField label={t("task.tags")} placeholder={t("task.tagsHint")} {...tags} />
        <TextArea label={t("task.notes")} rows={4} {...notes} />

        <section className="todo-subtasks" aria-label={t("subtasks.title")}>
          <h3>
            {t("subtasks.title")}{" "}
            {subtasks.length ? (
              <span className="todo-count">
                {subtasks.filter((subtask) => subtask.done).length}/{subtasks.length}
              </span>
            ) : null}
          </h3>
          <ul>
            {subtasks.map((subtask, index) => (
              <li key={subtask.id}>
                <Checkbox
                  label={subtask.title}
                  checked={subtask.done}
                  onChange={(checked) =>
                    set({
                      subtasks: subtasks.map((entry) =>
                        entry.id === subtask.id ? { ...entry, done: checked } : entry,
                      ),
                    })
                  }
                />
                <span className="eui-spacer" />
                <IconButton
                  size="sm"
                  label={t("task.moveUp")}
                  icon={<ArrowUp size={13} aria-hidden />}
                  onClick={() => moveSubtask(index, -1)}
                />
                <IconButton
                  size="sm"
                  label={t("task.moveDown")}
                  icon={<ArrowDown size={13} aria-hidden />}
                  onClick={() => moveSubtask(index, 1)}
                />
                <IconButton
                  size="sm"
                  label={t("subtasks.delete")}
                  icon={<X size={13} aria-hidden />}
                  onClick={() =>
                    set({ subtasks: subtasks.filter((entry) => entry.id !== subtask.id) })
                  }
                />
              </li>
            ))}
          </ul>
          <form
            className="todo-quick"
            onSubmit={(event) => {
              event.preventDefault();
              const text = newSubtask.trim();
              if (!text) return;
              set({
                subtasks: [...subtasks, { id: newId(), title: text.slice(0, 500), done: false }],
              });
              setNewSubtask("");
            }}
          >
            <input
              className="eui-input"
              aria-label={t("subtasks.add")}
              placeholder={t("subtasks.add")}
              value={newSubtask}
              maxLength={500}
              onChange={(event) => setNewSubtask(event.target.value)}
            />
            <Button
              type="submit"
              icon={<Plus size={14} aria-hidden />}
              disabled={!newSubtask.trim()}
            >
              {t("ui.add")}
            </Button>
          </form>
        </section>
      </div>
    </aside>
  );
}
