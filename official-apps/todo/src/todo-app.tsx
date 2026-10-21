import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  exportJson,
  IconButton,
  importJson,
  ListItem,
  LoadingState,
  SearchInput,
  Select,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
} from "@everyos/app-ui";
import {
  AlertCircle,
  BarChart3,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Download,
  FileUp,
  FolderPlus,
  Hash,
  Inbox,
  ListTodo,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { todayKey } from "./dates.ts";
import {
  complete,
  createTask,
  inList,
  matches,
  parseQuickAdd,
  reopen,
  sortTasks,
  type SmartList,
  type SortOrder,
  type Task,
} from "./model.ts";
import { ProgressView } from "./progress.tsx";
import { TaskDetail } from "./task-detail.tsx";
import { TaskRow } from "./task-row.tsx";
import { useReminders, useTodo } from "./use-todo.ts";

export type View =
  | { kind: "smart"; list: SmartList }
  | { kind: "project"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "progress" };

const SMART: Array<{ list: SmartList; icon: React.ReactNode }> = [
  { list: "inbox", icon: <Inbox size={16} aria-hidden /> },
  { list: "today", icon: <CalendarDays size={16} aria-hidden /> },
  { list: "upcoming", icon: <CalendarClock size={16} aria-hidden /> },
  { list: "overdue", icon: <AlertCircle size={16} aria-hidden /> },
  { list: "all", icon: <ListTodo size={16} aria-hidden /> },
  { list: "completed", icon: <CheckCircle2 size={16} aria-hidden /> },
];

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

function requestedTask(state: unknown): string | null {
  const id = (state as { taskId?: unknown } | null)?.taskId;
  return typeof id === "string" ? id : null;
}

export function TodoApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(820);
  const todo = useTodo();
  const { tasks, projects } = todo;
  useReminders(tasks, "window");
  const [view, setView] = usePersistentState<View>("view", { kind: "smart", list: "today" });
  const [sort, setSort] = usePersistentState<SortOrder>("sort", "manual");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    requestedTask(app.window.initialState),
  );
  const [quick, setQuick] = useState("");
  const [projectDialog, setProjectDialog] = useState<{ id: string | null; name: string } | null>(
    null,
  );
  const searchRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const today = todayKey();

  const { refresh } = todo;
  useEffect(
    () =>
      app.window.onOpened((state) => {
        const id = requestedTask(state);
        if (!id) return;
        setView({ kind: "smart", list: "all" });
        setQuery("");
        setSelectedId(id);
        void refresh();
      }),
    [app, setView, refresh],
  );

  const visible = useMemo(() => {
    if (!tasks) return [];
    const filtered = tasks.filter((task) => {
      if (!matches(task, query)) return false;
      switch (view.kind) {
        case "smart":
          return inList(task, view.list, today);
        case "project":
          return task.projectId === view.id && task.completedAt === null;
        case "tag":
          return task.tags.includes(view.name) && task.completedAt === null;
        case "progress":
          return false;
      }
    });
    if (view.kind === "smart" && view.list === "completed")
      return filtered.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return sortTasks(filtered, sort, i18n.tag);
  }, [tasks, query, view, today, sort, i18n.tag]);

  const selected = tasks?.find((task) => task.id === selectedId) ?? null;
  const counts = useMemo(() => {
    const result: Record<SmartList, number> = {
      inbox: 0,
      today: 0,
      upcoming: 0,
      overdue: 0,
      all: 0,
      completed: 0,
    };
    for (const task of tasks ?? [])
      for (const list of Object.keys(result) as SmartList[])
        if (inList(task, list, today)) result[list] += 1;
    return result;
  }, [tasks, today]);
  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const task of tasks ?? [])
      if (task.completedAt === null)
        for (const tag of task.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    return [...map].sort(([a], [b]) => a.localeCompare(b));
  }, [tasks]);

  const title =
    view.kind === "smart"
      ? t(`lists.${view.list}`)
      : view.kind === "project"
        ? (projects.find((project) => project.id === view.id)?.name ?? t("lists.all"))
        : view.kind === "tag"
          ? `#${view.name}`
          : t("progress.title");

  const addTask = async () => {
    const { title: text, tags: quickTags } = parseQuickAdd(quick);
    if (!text) return;
    const task = createTask(
      {
        title: text,
        tags: [...quickTags, ...(view.kind === "tag" ? [view.name] : [])],
        projectId: view.kind === "project" ? view.id : null,
        due:
          view.kind === "smart" && (view.list === "today" || view.list === "overdue")
            ? today
            : null,
        order: Date.now(),
      },
      Date.now(),
    );
    setQuick("");
    await todo.save(task);
    toast(t("task.added"));
  };

  const toggle = async (task: Task) => {
    if (task.completedAt !== null) {
      await todo.change(task.id, (current) => reopen(current, Date.now()));
      return;
    }
    await todo.change(task.id, (current) => complete(current, Date.now()));
    toast(task.recurrence ? t("task.nextOccurrence") : t("task.completed"));
  };

  const removeTask = async (task: Task) => {
    if (
      !(await app.dialogs.confirm(t("task.deleteTitle", { name: task.title }), t("ui.deleteBody"), {
        confirm: t("ui.delete"),
        destructive: true,
      }))
    )
      return;
    if (selectedId === task.id) setSelectedId(null);
    await todo.remove(task.id);
  };

  /** Moves a task one place up or down in its list (manual order). */
  const move = async (task: Task, step: -1 | 1) => {
    if (sort !== "manual") setSort("manual");
    const list = sortTasks(visible, "manual", i18n.tag);
    const index = list.findIndex((entry) => entry.id === task.id);
    const other = list[index + step];
    if (!other) return;
    const [a, b] = [task.order, other.order === task.order ? task.order + step : other.order];
    await todo.change(task.id, (current) => ({ ...current, order: b }));
    await todo.change(other.id, (current) => ({ ...current, order: a }));
  };

  useShortcuts({
    "mod+f": () => searchRef.current?.querySelector("input")?.focus(),
    "mod+n": () => quickRef.current?.focus(),
  });

  const exportAll = async () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (await exportJson(app, `todo-${day}.json`, await todo.store.exportAll()))
        toast(t("ui.exported"));
    } catch (caught) {
      todo.fail(caught);
    }
  };
  const importAll = async () => {
    try {
      const backup = await importJson(app, (value) => value);
      if (backup === null) return;
      const added = await todo.store.importBackup(backup);
      toast(t("backup.imported", { count: added }));
      await todo.refresh();
    } catch (caught) {
      todo.fail(caught);
    }
  };

  if (todo.error && !tasks)
    return <ErrorState error={todo.error} onRetry={() => void todo.refresh()} />;
  if (!tasks) return <LoadingState />;

  const sidebar = (
    <div className="todo-sidebar">
      {SMART.map(({ list, icon }) => (
        <ListItem
          key={list}
          icon={icon}
          title={t(`lists.${list}`)}
          selected={sameView(view, { kind: "smart", list })}
          trailing={
            <span
              className="todo-count"
              data-alert={list === "overdue" && counts.overdue > 0 ? true : undefined}
            >
              {counts[list]}
            </span>
          }
          onClick={() => setView({ kind: "smart", list })}
        />
      ))}
      <ListItem
        icon={<BarChart3 size={16} aria-hidden />}
        title={t("progress.title")}
        selected={view.kind === "progress"}
        onClick={() => setView({ kind: "progress" })}
      />
      <div className="todo-heading">
        <h2>{t("projects.title")}</h2>
        <IconButton
          size="sm"
          label={t("projects.add")}
          icon={<FolderPlus size={14} aria-hidden />}
          onClick={() => setProjectDialog({ id: null, name: "" })}
        />
      </div>
      {projects.map((project) => (
        <ListItem
          key={project.id}
          icon={<span className="todo-dot" style={{ background: project.color }} aria-hidden />}
          title={project.name}
          selected={sameView(view, { kind: "project", id: project.id })}
          trailing={
            <span className="todo-count">
              {
                tasks.filter((task) => task.projectId === project.id && task.completedAt === null)
                  .length
              }
            </span>
          }
          onClick={() => setView({ kind: "project", id: project.id })}
        />
      ))}
      {tags.length ? <h2 className="todo-heading">{t("tags.title")}</h2> : null}
      {tags.map(([name, count]) => (
        <ListItem
          key={name}
          icon={<Hash size={16} aria-hidden />}
          title={name}
          selected={sameView(view, { kind: "tag", name })}
          trailing={<span className="todo-count">{count}</span>}
          onClick={() => setView({ kind: "tag", name })}
        />
      ))}
    </div>
  );

  const project = view.kind === "project" ? projects.find((entry) => entry.id === view.id) : null;
  const list = (
    <section className="todo-list" aria-label={title}>
      <div className="todo-list-head">
        <h1 className="todo-title">{title}</h1>
        {project ? (
          <>
            <IconButton
              size="sm"
              label={t("projects.rename")}
              icon={<Pencil size={14} aria-hidden />}
              onClick={() => setProjectDialog({ id: project.id, name: project.name })}
            />
            <IconButton
              size="sm"
              label={t("projects.delete")}
              icon={<Trash2 size={14} aria-hidden />}
              onClick={async () => {
                if (
                  await app.dialogs.confirm(
                    t("projects.deleteTitle", { name: project.name }),
                    t("projects.deleteBody"),
                    { confirm: t("ui.delete"), destructive: true },
                  )
                ) {
                  await todo.store.removeProject(project.id);
                  setView({ kind: "smart", list: "inbox" });
                  await todo.refresh();
                }
              }}
            />
          </>
        ) : null}
        <Spacer />
        <div ref={searchRef} className="todo-search">
          <SearchInput value={query} onChange={setQuery} label={t("search.label")} />
        </div>
        <Select<SortOrder>
          label={t("sort.label")}
          hideLabel
          value={sort}
          onChange={setSort}
          options={(["manual", "due", "priority", "title"] as const).map((value) => ({
            value,
            label: t(`sort.${value}`),
          }))}
        />
      </div>
      {view.kind === "smart" && view.list === "completed" ? null : (
        <form
          className="todo-quick"
          onSubmit={(event) => {
            event.preventDefault();
            void addTask();
          }}
        >
          <input
            ref={quickRef}
            className="eui-input"
            aria-label={t("task.quickAdd")}
            placeholder={t("task.quickAddPlaceholder")}
            value={quick}
            maxLength={500}
            onChange={(event) => setQuick(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!quick.trim()}>
            {t("ui.add")}
          </Button>
        </form>
      )}
      {visible.length ? (
        <ul className="todo-rows" aria-label={title}>
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              project={projects.find((entry) => entry.id === task.projectId) ?? null}
              today={today}
              selected={task.id === selectedId}
              onSelect={() => setSelectedId(task.id)}
              onToggle={() => void toggle(task)}
              onMove={(step) => void move(task, step)}
              onDelete={() => void removeTask(task)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<CheckCircle2 size={30} aria-hidden />}
          title={
            query ? t("search.none") : t(`empty.${view.kind === "smart" ? view.list : "list"}`)
          }
        />
      )}
    </section>
  );

  const detail = selected ? (
    <TaskDetail
      key={selected.id}
      task={selected}
      projects={projects}
      onChange={(update) => void todo.change(selected.id, update)}
      onToggle={() => void toggle(selected)}
      onDelete={() => void removeTask(selected)}
      onClose={() => setSelectedId(null)}
    />
  ) : null;

  return (
    <>
      <Shell
        sidebarWidth={230}
        toolbar={(sidebarButton) => (
          <Toolbar label={t("app.name")}>
            {sidebarButton}
            <ToolbarTitle>{t("app.name")}</ToolbarTitle>
            <Spacer />
            <IconButton
              label={t("backup.import")}
              icon={<FileUp size={16} aria-hidden />}
              onClick={() => void importAll()}
            />
            <IconButton
              label={t("backup.export")}
              icon={<Download size={16} aria-hidden />}
              onClick={() => void exportAll()}
            />
          </Toolbar>
        )}
        sidebar={sidebar}
      >
        {view.kind === "progress" ? (
          <ProgressView tasks={tasks} projects={projects} />
        ) : (
          <div className="todo-body" data-detail={detail && !narrow ? true : undefined}>
            {!narrow || !detail ? list : null}
            {detail}
          </div>
        )}
      </Shell>
      <Dialog
        open={projectDialog !== null}
        title={projectDialog?.id ? t("projects.rename") : t("projects.add")}
        onClose={() => setProjectDialog(null)}
        actions={
          <>
            <Button onClick={() => setProjectDialog(null)}>{t("ui.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!projectDialog?.name.trim()}
              onClick={async () => {
                if (!projectDialog?.name.trim()) return;
                try {
                  if (projectDialog.id) {
                    await todo.store.saveProjects(
                      projects.map((entry) =>
                        entry.id === projectDialog.id
                          ? { ...entry, name: projectDialog.name.trim().slice(0, 80) }
                          : entry,
                      ),
                    );
                  } else {
                    const created = await todo.store.addProject(projectDialog.name);
                    setView({ kind: "project", id: created.id });
                  }
                  setProjectDialog(null);
                  await todo.refresh();
                } catch (caught) {
                  todo.fail(caught);
                }
              }}
            >
              {projectDialog?.id ? t("ui.rename") : t("ui.create")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("projects.name")}
          value={projectDialog?.name ?? ""}
          maxLength={80}
          autoFocus
          onChange={(event) =>
            setProjectDialog((current) =>
              current ? { ...current, name: event.target.value } : current,
            )
          }
        />
      </Dialog>
    </>
  );
}
