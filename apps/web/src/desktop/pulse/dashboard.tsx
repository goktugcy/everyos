import type { BackupJobView, TaskOccurrence, UpdateJobView } from "@everyos/shared";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLiveMetrics, useLiveMetricsSubscription } from "../../features/metrics/live-metrics.ts";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { cn } from "../../lib/cn.ts";
import { formatCelsius, formatClock, formatPercent, localeTag } from "../../lib/format.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { desktop } from "../state/controller.ts";
import { dayKey, firstDayOfWeek, gridRange, monthGrid } from "./pulse-lib.ts";

const heading = "mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-fg-subtle";

function Meter({ label, value, text }: { label: string; value: number | null; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[0.72rem]">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums text-fg">{text}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover/12">
        <div
          className="h-full rounded-full bg-[rgb(var(--everyos-accent))] transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
        />
      </div>
    </div>
  );
}

function SystemColumn({
  backup,
  update,
}: {
  backup: BackupJobView | null;
  update: UpdateJobView | null;
}) {
  const { t, i18n } = useTranslation();
  const canSystem = usePermissions().includes("system:read");
  useLiveMetricsSubscription(canSystem);
  const point = useLiveMetrics((state) => state.snapshot?.point);
  const cpu = point?.cpuPercent ?? null;
  const memory =
    typeof point?.memoryUsedBytes === "number" && point.memoryTotalBytes
      ? (point.memoryUsedBytes / point.memoryTotalBytes) * 100
      : null;
  const temperature = typeof point?.temperatureC === "number" ? point.temperatureC : null;
  const jobs = [
    backup
      ? {
          id: "backup",
          label: t(backup.kind === "restore" ? "backups.restoring" : "backups.creating"),
          detail: t(`backups.stages.${backup.stage}`),
          open: () => desktop.openApp("everyos.backups"),
        }
      : null,
    update
      ? {
          id: "update",
          label: t("pulse.updating"),
          detail: update.packages ? update.packages.join(", ") : t("pulse.allPackages"),
          open: () => desktop.openApp("everyos.updates"),
        }
      : null,
  ].filter((job) => job !== null);
  return (
    <div className="flex w-52 shrink-0 flex-col gap-3">
      {canSystem ? (
        <section className="flex flex-col gap-2" data-testid="pulse-system">
          <h3 className={heading}>{t("pulse.system")}</h3>
          <Meter
            label={t("monitor.cpu")}
            value={cpu}
            text={cpu === null ? "—" : formatPercent(cpu, i18n.language)}
          />
          <Meter
            label={t("monitor.memory")}
            value={memory}
            text={memory === null ? "—" : formatPercent(memory, i18n.language)}
          />
          {temperature !== null ? (
            <Meter
              label={t("monitor.temperature")}
              value={(temperature / 90) * 100}
              text={formatCelsius(temperature, i18n.language)}
            />
          ) : null}
        </section>
      ) : null}
      <section className="flex min-h-0 flex-col">
        <h3 className={heading}>{t("pulse.activity")}</h3>
        {jobs.length === 0 ? (
          <p className="text-[0.75rem] text-fg-subtle">{t("pulse.idle")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={job.open}
                  className="flex w-full flex-col rounded-lg bg-hover/8 px-2.5 py-1.5 text-left outline-none hover:bg-hover/12 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="text-[0.75rem] font-medium text-fg">{job.label}</span>
                  <span className="truncate text-[0.68rem] text-fg-muted">{job.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Calendar, the selected day's scheduled runs, live system values and running jobs. */
export function PulseDashboard({
  backup,
  update,
}: {
  backup: BackupJobView | null;
  update: UpdateJobView | null;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const canTasks = usePermissions().includes("tasks:manage");
  const today = new Date();
  const [month, setMonth] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [selected, setSelected] = useState(dayKey(today));
  const firstDay = firstDayOfWeek(localeTag(language));
  const cells = useMemo(
    () => monthGrid(month.year, month.month, firstDay),
    [month.year, month.month, firstDay],
  );
  const range = gridRange(cells);
  const calendar = useApiResource<{ days: Record<string, number> }>(
    canTasks ? `/tasks/calendar?from=${range.from}&to=${range.to}` : null,
    60_000,
  );
  const [y, m, d] = selected.split("-").map(Number) as [number, number, number];
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = new Date(y, m - 1, d + 1).getTime();
  const events = useApiResource<{ occurrences: TaskOccurrence[] }>(
    canTasks ? `/tasks/calendar?from=${dayStart}&to=${dayEnd}` : null,
    60_000,
  );
  const tag = localeTag(language);
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(tag, { weekday: "narrow" }).format(
      // 2023-01-01 was a Sunday.
      new Date(2023, 0, 1 + ((firstDay + index) % 7)),
    ),
  );
  const shift = (step: number) =>
    setMonth((current) => {
      const next = new Date(current.year, current.month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  const todayKey = dayKey(today);
  const list = events.data?.occurrences ?? [];

  return (
    <div className="flex h-full gap-5 text-fg">
      <section className="w-[212px] shrink-0" aria-label={t("pulse.calendar")}>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[0.82rem] font-semibold capitalize" data-testid="pulse-month">
            {new Intl.DateTimeFormat(tag, { month: "long", year: "numeric" }).format(
              new Date(month.year, month.month, 1),
            )}
          </span>
          <span className="flex">
            <button
              type="button"
              aria-label={t("pulse.previousMonth")}
              onClick={() => shift(-1)}
              className="grid size-6 place-items-center rounded-full text-fg-muted outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t("pulse.nextMonth")}
              onClick={() => shift(1)}
              className="grid size-6 place-items-center rounded-full text-fg-muted outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </span>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center">
          {weekdays.map((name, index) => (
            <span key={index} className="text-[0.62rem] font-semibold text-fg-subtle">
              {name}
            </span>
          ))}
          {cells.map((cell) => {
            const count = calendar.data?.days[cell.key] ?? 0;
            const isToday = cell.key === todayKey;
            return (
              <button
                key={cell.key}
                type="button"
                aria-label={new Intl.DateTimeFormat(tag, { dateStyle: "full" }).format(cell.date)}
                aria-pressed={cell.key === selected}
                data-has-events={count > 0 || undefined}
                onClick={() => setSelected(cell.key)}
                className={cn(
                  "relative mx-auto grid size-[26px] place-items-center rounded-full text-[0.72rem] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  cell.inMonth ? "text-fg" : "text-fg-subtle/60",
                  isToday &&
                    "bg-[rgb(var(--everyos-accent))] font-semibold text-[rgb(var(--everyos-accent-contrast))]",
                  !isToday && cell.key === selected && "bg-hover/15",
                  !isToday && cell.key !== selected && "hover:bg-hover/10",
                )}
              >
                {cell.date.getDate()}
                {count > 0 ? (
                  <span
                    className={cn(
                      "absolute bottom-0.5 size-1 rounded-full",
                      isToday
                        ? "bg-[rgb(var(--everyos-accent-contrast))]"
                        : "bg-[rgb(var(--everyos-accent))]",
                    )}
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col" data-testid="pulse-day">
        <h3 className={heading}>
          {selected === todayKey
            ? t("pulse.today")
            : new Intl.DateTimeFormat(tag, {
                weekday: "long",
                day: "numeric",
                month: "long",
              }).format(new Date(dayStart))}
        </h3>
        {!canTasks ? (
          <p className="text-[0.75rem] text-fg-subtle">{t("pulse.noCalendar")}</p>
        ) : list.length === 0 ? (
          <p className="text-[0.75rem] text-fg-subtle">
            {events.loading ? "…" : t("pulse.noEvents")}
          </p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-1">
            {list.slice(0, 30).map((event) => (
              <li key={`${event.taskId}-${event.at}`}>
                <button
                  type="button"
                  onClick={() => desktop.openApp("everyos.tasks")}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left outline-none hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="h-6 w-0.5 shrink-0 rounded-full bg-[rgb(var(--everyos-accent))]" />
                  <span className="w-11 shrink-0 text-[0.72rem] tabular-nums text-fg-muted">
                    {formatClock(event.at, language)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.78rem] text-fg">{event.name}</span>
                    <span className="block truncate text-[0.66rem] text-fg-subtle">
                      {t(`tasks.types.${event.type}`)}
                    </span>
                  </span>
                  <CalendarClock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                </button>
              </li>
            ))}
            {list.length > 30 ? (
              <li className="px-2 text-[0.68rem] text-fg-subtle">
                {t("pulse.more", { count: list.length - 30 })}
              </li>
            ) : null}
          </ul>
        )}
      </section>

      <SystemColumn backup={backup} update={update} />
    </div>
  );
}
