import { useI18n, useT } from "@everyos/app-ui";
import { addDays, fromKey, todayKey, toKey } from "./dates.ts";
import { inList, type Project, type Task } from "./model.ts";

/** Completions per day for the last 7 days (repeating tasks count every occurrence). */
export function completedPerDay(
  tasks: readonly Task[],
  now: number,
): Array<{ day: string; count: number }> {
  const today = todayKey(now);
  const days = Array.from({ length: 7 }, (_, index) => ({
    day: addDays(today, index - 6),
    count: 0,
  }));
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  for (const task of tasks)
    for (const at of [
      ...task.completions,
      ...(task.completedAt !== null ? [task.completedAt] : []),
    ]) {
      const entry = byDay.get(toKey(new Date(at)));
      if (entry) entry.count += 1;
    }
  return days;
}

export function ProgressView({
  tasks,
  projects,
}: {
  tasks: readonly Task[];
  projects: readonly Project[];
}) {
  const t = useT();
  const i18n = useI18n();
  const now = Date.now();
  const today = todayKey(now);
  const days = completedPerDay(tasks, now);
  const max = Math.max(4, ...days.map((day) => day.count));
  const groups = [
    { id: null, name: t("lists.inbox"), color: "var(--eui-subtle)" },
    ...projects.map((project) => ({ id: project.id, name: project.name, color: project.color })),
  ];
  return (
    <div className="todo-progress">
      <div className="todo-cards">
        <Card
          label={t("lists.today")}
          value={i18n.number(tasks.filter((task) => inList(task, "today", today)).length)}
        />
        <Card
          label={t("lists.overdue")}
          value={i18n.number(tasks.filter((task) => inList(task, "overdue", today)).length)}
          tone="danger"
        />
        <Card
          label={t("progress.open")}
          value={i18n.number(tasks.filter((task) => task.completedAt === null).length)}
        />
        <Card
          label={t("progress.week")}
          value={i18n.number(days.reduce((sum, day) => sum + day.count, 0))}
        />
      </div>
      <figure className="todo-chart">
        <figcaption>{t("progress.chart")}</figcaption>
        <svg viewBox="0 0 350 150" role="img" aria-label={t("progress.chart")}>
          {days.map((day, index) => {
            const height = (day.count / max) * 110;
            return (
              <g key={day.day} transform={`translate(${index * 50 + 10}, 0)`}>
                <title>{`${i18n.date(fromKey(day.day), { weekday: "long" })}: ${day.count}`}</title>
                <rect
                  className="todo-bar"
                  x={4}
                  y={120 - height}
                  width={30}
                  height={Math.max(height, 1)}
                  rx={5}
                />
                <text x={19} y={140} textAnchor="middle" className="todo-axis">
                  {i18n.date(fromKey(day.day), { weekday: "short" })}
                </text>
              </g>
            );
          })}
        </svg>
      </figure>
      <section aria-label={t("projects.title")}>
        <h2 className="todo-heading">{t("projects.title")}</h2>
        <ul className="todo-project-progress">
          {groups.map((group) => {
            const own = tasks.filter((task) => task.projectId === group.id && !task.recurrence);
            const done = own.filter((task) => task.completedAt !== null).length;
            const percent = own.length ? Math.round((done / own.length) * 100) : 0;
            return (
              <li key={group.id ?? "inbox"}>
                <span className="todo-project">
                  <span className="todo-dot" style={{ background: group.color }} aria-hidden />
                  {group.name}
                </span>
                <span
                  className="todo-meter"
                  role="progressbar"
                  aria-label={group.name}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span style={{ width: `${percent}%`, background: group.color }} />
                </span>
                <span className="todo-count">
                  {t("progress.done", { done, total: own.length })}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="todo-card" data-tone={tone}>
      <span className="todo-card-value">{value}</span>
      <span className="todo-card-label">{label}</span>
    </div>
  );
}
