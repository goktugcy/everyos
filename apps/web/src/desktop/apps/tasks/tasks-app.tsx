import {
  type InstalledAppView,
  type ServiceList,
  type TaskNotify,
  type TaskRunView,
  type TaskType,
  type TaskView,
  type DockerContainerView,
} from "@everyos/shared";
import {
  CircleCheck,
  CircleSlash,
  Loader2,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatDateTime, formatRelative } from "../../../lib/format.ts";
import { localized } from "../store/parts.tsx";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { fromCron, pad, previewNext, toCron, type ScheduleForm } from "./schedule.ts";

const MODES = ["hourly", "daily", "weekly", "monthly", "custom"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function useDescribe() {
  const { t } = useTranslation();
  return (expression: string) => {
    const form = fromCron(expression);
    const time = "hour" in form ? `${pad(form.hour)}:${pad(form.minute)}` : "";
    switch (form.mode) {
      case "hourly":
        return t("tasks.describe.hourly", { minute: pad(form.minute) });
      case "daily":
        return t("tasks.describe.daily", { time });
      case "weekly":
        return t("tasks.describe.weekly", {
          day: t(`tasks.weekdays.${WEEKDAY_KEYS[form.weekday]!}`),
          time,
        });
      case "monthly":
        return t("tasks.describe.monthly", { day: form.day, time });
      case "custom":
        return form.expression;
    }
  };
}

function StatusLabel({ status, running }: { status: TaskView["lastStatus"]; running: boolean }) {
  const { t } = useTranslation();
  if (running)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-accent">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("tasks.status.running")}
      </span>
    );
  if (!status) return <span className="text-xs text-fg-subtle">—</span>;
  const Icon =
    status === "succeeded" ? CircleCheck : status === "failed" ? TriangleAlert : CircleSlash;
  return (
    <span
      className={
        status === "succeeded"
          ? "inline-flex items-center gap-1 text-xs font-medium text-success"
          : status === "failed"
            ? "inline-flex items-center gap-1 text-xs font-medium text-danger"
            : "inline-flex items-center gap-1 text-xs text-fg-muted"
      }
    >
      <Icon className="size-3.5" aria-hidden />
      {t(`tasks.status.${status}`)}
    </span>
  );
}

function ScheduleEditor({
  value,
  onChange,
}: {
  value: ScheduleForm;
  onChange: (form: ScheduleForm) => void;
}) {
  const { t, i18n } = useTranslation();
  const expression = toCron(value);
  const next = previewNext(expression);
  const time = "hour" in value ? `${pad(value.hour)}:${pad(value.minute)}` : "00:00";
  const setTime = (text: string) => {
    const [h, m] = text.split(":").map(Number);
    if ("hour" in value && Number.isInteger(h) && Number.isInteger(m))
      onChange({ ...value, hour: h!, minute: m! });
  };
  const change = (mode: ScheduleForm["mode"]) => {
    const hour = "hour" in value ? value.hour : 3;
    const minute = "minute" in value ? value.minute : 0;
    onChange(
      mode === "hourly"
        ? { mode, minute }
        : mode === "daily"
          ? { mode, hour, minute }
          : mode === "weekly"
            ? { mode, weekday: 1, hour, minute }
            : mode === "monthly"
              ? { mode, day: 1, hour, minute }
              : { mode, expression },
    );
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1.5 text-[0.8rem] font-medium text-fg-muted">
        {t("tasks.form.schedule")}
      </legend>
      <Select
        label={t("tasks.form.repeat")}
        value={value.mode}
        options={MODES.map((mode) => ({ value: mode, label: t(`tasks.modes.${mode}`) }))}
        onChange={change}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {value.mode === "hourly" ? (
          <Field
            label={t("tasks.form.minute")}
            type="number"
            min={0}
            max={59}
            value={value.minute}
            onChange={(event) =>
              onChange({ ...value, minute: Math.max(0, Math.min(59, Number(event.target.value))) })
            }
          />
        ) : null}
        {value.mode === "weekly" ? (
          <Select
            label={t("tasks.form.weekday")}
            value={String(value.weekday)}
            options={WEEKDAYS.map((day) => ({
              value: String(day),
              label: t(`tasks.weekdays.${WEEKDAY_KEYS[day]}`),
            }))}
            onChange={(day) => onChange({ ...value, weekday: Number(day) })}
          />
        ) : null}
        {value.mode === "monthly" ? (
          <Field
            label={t("tasks.form.day")}
            type="number"
            min={1}
            max={28}
            value={value.day}
            onChange={(event) =>
              onChange({ ...value, day: Math.max(1, Math.min(28, Number(event.target.value))) })
            }
          />
        ) : null}
        {value.mode === "daily" || value.mode === "weekly" || value.mode === "monthly" ? (
          <Field
            label={t("tasks.form.time")}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        ) : null}
        {value.mode === "custom" ? (
          <Field
            label={t("tasks.form.cron")}
            hint={t("tasks.form.cronHint")}
            value={value.expression}
            className="font-mono"
            onChange={(event) => onChange({ mode: "custom", expression: event.target.value })}
          />
        ) : null}
      </div>
      <p className="text-xs text-fg-muted" role="status">
        {next
          ? t("tasks.form.nextRun", { time: formatDateTime(next, i18n.language) })
          : t("tasks.form.invalidSchedule")}
      </p>
    </fieldset>
  );
}

interface Draft {
  name: string;
  type: TaskType;
  params: Record<string, string>;
  schedule: ScheduleForm;
  enabled: boolean;
  notify: TaskNotify;
  catchUp: boolean;
}

function TaskDialog({
  task,
  types,
  onClose,
  onSaved,
}: {
  task: TaskView | null;
  types: TaskType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() =>
    task
      ? {
          name: task.name,
          type: task.type,
          params: task.params,
          schedule: fromCron(task.schedule),
          enabled: task.enabled,
          notify: task.notify,
          catchUp: task.catchUp,
        }
      : {
          name: "",
          type: types[0] ?? "updates.refresh",
          params: {},
          schedule: { mode: "daily", hour: 3, minute: 30 },
          enabled: true,
          notify: "failure",
          catchUp: true,
        },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const services = useApiResource<ServiceList>(
    draft.type === "service.restart" ? "/services" : null,
    null,
  );
  const containers = useApiResource<{ containers: DockerContainerView[] }>(
    draft.type === "container.restart" ? "/docker/containers" : null,
    null,
  );
  const apps = useApiResource<{ apps: InstalledAppView[] }>(
    draft.type === "app.update" ? "/apps" : null,
    null,
  );
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: draft.name.trim() || t(`tasks.types.${draft.type}`),
      schedule: toCron(draft.schedule),
      enabled: draft.enabled,
      notify: draft.notify,
      catchUp: draft.catchUp,
    };
    try {
      if (task) await api(`/tasks/${task.id}`, { method: "PATCH", body });
      else
        await api("/tasks", {
          method: "POST",
          body: { ...body, type: draft.type, params: draft.params },
        });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const choice = (key: string, label: string, options: Array<{ value: string; label: string }>) => (
    <Select
      label={label}
      value={draft.params[key] ?? ""}
      options={[{ value: "", label: t("tasks.form.choose") }, ...options]}
      onChange={(value) => set({ params: { [key]: value } })}
    />
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={task ? t("tasks.edit") : t("tasks.add")}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Select
          label={t("tasks.form.type")}
          value={draft.type}
          options={(task ? [task.type] : types).map((type) => ({
            value: type,
            label: t(`tasks.types.${type}`),
          }))}
          onChange={(type) => set({ type, params: {} })}
        />
        <p className="-mt-2 text-xs text-fg-muted">{t(`tasks.typeHints.${draft.type}`)}</p>
        {!task && draft.type === "service.restart"
          ? choice(
              "unit",
              t("tasks.form.service"),
              (services.data?.units ?? []).map((unit) => ({ value: unit.name, label: unit.name })),
            )
          : null}
        {!task && draft.type === "container.restart"
          ? choice(
              "container",
              t("tasks.form.container"),
              (containers.data?.containers ?? []).map((c) => ({ value: c.name, label: c.name })),
            )
          : null}
        {!task && draft.type === "app.update"
          ? choice(
              "appId",
              t("tasks.form.app"),
              (apps.data?.apps ?? []).map((app) => ({
                value: app.id,
                label: localized(app.name, i18n.language) || app.project,
              })),
            )
          : null}
        <Field
          label={t("tasks.form.name")}
          value={draft.name}
          maxLength={80}
          placeholder={t(`tasks.types.${draft.type}`)}
          onChange={(event) => set({ name: event.target.value })}
        />
        <ScheduleEditor value={draft.schedule} onChange={(schedule) => set({ schedule })} />
        <Select
          label={t("tasks.form.notify")}
          value={draft.notify}
          options={(["failure", "always", "never"] as const).map((value) => ({
            value,
            label: t(`tasks.notify.${value}`),
          }))}
          onChange={(notify) => set({ notify })}
        />
        <label className="flex items-center justify-between gap-4 text-sm">
          <span className="flex flex-col">
            <span>{t("tasks.form.catchUp")}</span>
            <span className="text-xs text-fg-muted">{t("tasks.form.catchUpHint")}</span>
          </span>
          <Toggle
            label={t("tasks.form.catchUp")}
            checked={draft.catchUp}
            onCheckedChange={(catchUp) => set({ catchUp })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{t("tasks.form.enabled")}</span>
          <Toggle
            label={t("tasks.form.enabled")}
            checked={draft.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
          />
        </label>
        <p className="text-xs text-fg-muted">{t("tasks.form.ownerHint")}</p>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            loading={saving}
            disabled={previewNext(toCron(draft.schedule)) === null}
          >
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Runs({ taskId, revision }: { taskId: string; revision: number }) {
  const { t, i18n } = useTranslation();
  const runs = useApiResource<{ runs: TaskRunView[] }>(`/tasks/${taskId}/runs`, null, revision);
  return (
    <tr>
      <td colSpan={6} className="bg-hover/4 px-4 py-2">
        <ResourceError error={runs.error} />
        {runs.data?.runs.length === 0 ? (
          <p className="text-xs text-fg-muted">{t("tasks.noRuns")}</p>
        ) : null}
        <ul className="flex flex-col gap-1 text-xs" data-testid="task-runs">
          {runs.data?.runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-x-3">
              <span className="text-fg-muted">{formatDateTime(run.startedAt, i18n.language)}</span>
              <span>{t(`tasks.triggers.${run.trigger}`)}</span>
              <StatusLabel
                status={run.status === "running" ? null : run.status}
                running={run.status === "running"}
              />
              {run.summary !== null ? (
                <span>{t("tasks.summary", { summary: run.summary })}</span>
              ) : null}
              {run.error ? (
                <span className="text-danger">
                  {t(
                    `tasks.errors.${run.error === "owner-unauthorized" || run.error === "busy" || run.error === "not-found" ? run.error : "other"}`,
                    { code: run.error },
                  )}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

/** Scheduled tasks: predefined actions on a schedule, with history and notifications. */
export default function TasksApp() {
  const { t, i18n } = useTranslation();
  const describe = useDescribe();
  const [revision, setRevision] = useState(0);
  const [anyRunning, setAnyRunning] = useState(false);
  // Faster refresh while something runs, so results appear promptly.
  const list = useApiResource<{ tasks: TaskView[]; types: TaskType[] }>(
    "/tasks",
    anyRunning ? 1_000 : 10_000,
    revision,
  );
  const running = list.data?.tasks.some((task) => task.running) ?? false;
  if (running !== anyRunning) setAnyRunning(running);
  const [editing, setEditing] = useState<TaskView | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = () => setRevision((n) => n + 1);

  const act = async (
    path: string,
    init: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
  ) => {
    setError(null);
    try {
      await api(path, init);
      reload();
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tasks-app">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="text-xs text-fg-muted">{t("tasks.intro")}</p>
        <Button size="sm" onClick={() => setEditing("new")} disabled={!list.data?.types.length}>
          <Plus className="size-4" aria-hidden />
          {t("tasks.add")}
        </Button>
      </div>
      {error ? (
        <div className="px-4 pt-3">
          <Alert tone="danger">{errorMessage(t, error)}</Alert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <ResourceError error={list.error} />
        {list.loading ? <LoadingBlock /> : null}
        {list.data?.tasks.length === 0 ? (
          <p className="p-10 text-center text-sm text-fg-muted">{t("tasks.empty")}</p>
        ) : null}
        {list.data && list.data.tasks.length > 0 ? (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[rgb(var(--everyos-surface)/0.95)] text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-1.5 font-semibold">
                  {t("tasks.columns.name")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tasks.columns.schedule")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tasks.columns.next")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tasks.columns.last")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tasks.columns.enabled")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  <span className="sr-only">{t("tasks.columns.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  describe={describe(task.schedule)}
                  nextLabel={task.nextRunAt ? formatRelative(task.nextRunAt, i18n.language) : "—"}
                  expanded={expanded === task.id}
                  revision={revision}
                  onToggleRuns={() =>
                    setExpanded((current) => (current === task.id ? null : task.id))
                  }
                  onEdit={() => setEditing(task)}
                  onAction={act}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {editing ? (
        <TaskDialog
          task={editing === "new" ? null : editing}
          types={list.data?.types ?? []}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  describe,
  nextLabel,
  expanded,
  revision,
  onToggleRuns,
  onEdit,
  onAction,
}: {
  task: TaskView;
  describe: string;
  nextLabel: string;
  expanded: boolean;
  revision: number;
  onToggleRuns: () => void;
  onEdit: () => void;
  onAction: (
    path: string,
    init: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <tr className="border-t border-line" data-testid="task-row">
        <td className="px-4 py-2">
          <button
            type="button"
            className="flex flex-col text-left"
            onClick={onToggleRuns}
            aria-expanded={expanded}
          >
            <span className="font-medium">{task.name}</span>
            <span className="text-xs text-fg-muted">
              {t(`tasks.types.${task.type}`)}
              {(task.params.unit ?? task.params.container)
                ? ` · ${task.params.unit ?? task.params.container}`
                : ""}
              {task.owner ? ` · ${task.owner}` : ""}
            </span>
          </button>
        </td>
        <td className="px-2 py-2 text-xs">{describe}</td>
        <td className="px-2 py-2 text-xs text-fg-muted">{task.enabled ? nextLabel : "—"}</td>
        <td className="px-2 py-2">
          <StatusLabel status={task.lastStatus} running={task.running} />
        </td>
        <td className="px-2 py-2">
          <Toggle
            label={t("tasks.columns.enabled")}
            checked={task.enabled}
            onCheckedChange={(enabled) =>
              void onAction(`/tasks/${task.id}`, { method: "PATCH", body: { enabled } })
            }
          />
        </td>
        <td className="px-2 py-2">
          <div className="flex justify-end gap-1">
            {task.running ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void onAction(`/tasks/${task.id}/cancel`, { method: "POST", body: {} })
                }
              >
                <Square className="size-3.5" aria-hidden />
                {t("tasks.cancel")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onAction(`/tasks/${task.id}/run`, { method: "POST", body: {} })}
              >
                <Play className="size-3.5" aria-hidden />
                {t("tasks.runNow")}
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("tasks.edit")}
              title={t("tasks.edit")}
              onClick={onEdit}
            >
              <Pencil className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("common.delete")}
              title={t("common.delete")}
              onClick={async () => {
                const ok = await requestConfirm({
                  title: t("tasks.deleteTitle"),
                  body: t("tasks.deleteBody", { name: task.name }),
                  confirmLabel: t("common.delete"),
                  danger: true,
                });
                if (ok) await onAction(`/tasks/${task.id}`, { method: "DELETE" });
              }}
            >
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </div>
        </td>
      </tr>
      {expanded ? <Runs taskId={task.id} revision={revision} /> : null}
    </>
  );
}
