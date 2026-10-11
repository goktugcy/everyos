import { BarChart3, Table2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TimeSeriesChart, type TimeSeriesChartProps } from "./time-series-chart.tsx";

const TABLE_ROWS = 30;

/**
 * A titled chart with its legend and an equivalent table view, so no value
 * is reachable only by hovering. Two or more series always get a legend;
 * each legend entry also shows the latest value.
 */
export function ChartCard({
  title,
  headline,
  chart,
  emptyLabel,
}: {
  title: string;
  /** Latest value shown next to a single-series title. */
  headline?: ReactNode;
  chart: TimeSeriesChartProps;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  const [table, setTable] = useState(false);
  const { series, times, formatValue, formatTime } = chart;
  const latest = (values: ReadonlyArray<number | null>) => {
    for (let i = values.length - 1; i >= 0; i--) {
      const value = values[i];
      if (typeof value === "number") return value;
    }
    return null;
  };
  const hasData = series.some((s) => s.values.some((v) => v !== null));

  return (
    <section
      className="glass-inset flex min-w-0 flex-col gap-2 rounded-everyos-md p-3"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {series.length >= 2 ? (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted">
              {series.map((s) => {
                const value = latest(s.values);
                return (
                  <li key={s.id} className="flex items-center gap-1.5">
                    <span
                      className="h-0.5 w-3 rounded-full"
                      style={{ background: s.color }}
                      aria-hidden
                    />
                    <span>{s.label}</span>
                    <span className="font-semibold tabular-nums text-fg">
                      {value === null ? "—" : formatValue(value)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : headline !== undefined ? (
            <p className="mt-0.5 text-lg font-semibold text-fg">{headline}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setTable((value) => !value)}
          className="grid size-7 shrink-0 place-items-center rounded-everyos-sm text-fg-subtle outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          aria-pressed={table}
          aria-label={table ? t("monitor.showChart") : t("monitor.showTable")}
          title={table ? t("monitor.showChart") : t("monitor.showTable")}
        >
          {table ? (
            <BarChart3 className="size-4" aria-hidden />
          ) : (
            <Table2 className="size-4" aria-hidden />
          )}
        </button>
      </div>
      {!hasData ? (
        <p
          className="grid place-items-center text-xs text-fg-subtle"
          style={{ height: chart.height ?? 150 }}
        >
          {emptyLabel}
        </p>
      ) : table ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[rgb(var(--everyos-surface)/0.95)] text-fg-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-semibold">
                  {t("monitor.time")}
                </th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="py-1 pr-3 text-right font-semibold">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {times
                .map((time, index) => ({ time, index }))
                .slice(-TABLE_ROWS)
                .reverse()
                .map(({ time, index }) => (
                  <tr key={time} className="border-t border-line">
                    <td className="py-1 pr-3 text-fg-muted">{formatTime(time)}</td>
                    {series.map((s) => (
                      <td key={s.id} className="py-1 pr-3 text-right text-fg">
                        {typeof s.values[index] !== "number" ? "—" : formatValue(s.values[index])}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <TimeSeriesChart {...chart} />
      )}
    </section>
  );
}
