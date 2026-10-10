import {
  METRIC_RANGES,
  type MetricRange,
  type MetricsHistory,
  type MetricsPoint,
} from "@otuken/shared";
import { useTranslation } from "react-i18next";
import { ChartCard } from "../../../components/charts/chart-card.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useLiveMetrics } from "../../../features/metrics/live-metrics.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import {
  formatBytes,
  formatCelsius,
  formatClock,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../../../lib/format.ts";
import { useAppStateField } from "../app-context.ts";
import { ResourceError, SimulatedBadge, StatTile } from "./parts.tsx";

const RANGE_MS: Record<MetricRange, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};
/** Gaps longer than this mean missing samples (agent down, server off). */
const MAX_GAP_MS: Record<MetricRange, number> = {
  "15m": 150_000,
  "1h": 150_000,
  "24h": 12 * 60_000,
};

function column(points: readonly MetricsPoint[], pick: (point: MetricsPoint) => number | null) {
  return points.map(pick);
}

export function OverviewTab() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [range, setRange] = useAppStateField<MetricRange>("range", METRIC_RANGES, "15m");
  const snapshot = useLiveMetrics((state) => state.snapshot);
  const livePoints = useLiveMetrics((state) => state.points);
  const status = useLiveMetrics((state) => state.status);
  const history = useApiResource<MetricsHistory>(
    range === "15m" ? null : `/system/metrics/history?range=${range}`,
    60_000,
  );

  const points = range === "15m" ? livePoints : (history.data?.points ?? []);
  const times = points.map((point) => point.at);
  // The newest sample anchors the window (charts stay pure; no clock reads during render).
  const end = Math.max(times.at(-1) ?? 0, snapshot?.point.at ?? 0);
  const domain = [end - RANGE_MS[range], end] as const;
  const point = snapshot?.point;
  const rate = (value: number) => t("monitor.perSecond", { value: formatBytes(value, language) });
  const clock = (time: number) => formatClock(time, language);
  const rangeLabel = t(`monitor.ranges.${range}`);
  const chartBase = {
    times,
    domain,
    formatTime: clock,
    maxGapMs: MAX_GAP_MS[range],
    dimmed: range !== "15m" && history.refreshing,
  };
  const memoryPercent =
    typeof point?.memoryUsedBytes === "number" && point.memoryTotalBytes
      ? (point.memoryUsedBytes / point.memoryTotalBytes) * 100
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select
          label={t("monitor.rangeLabel")}
          value={range}
          onChange={setRange}
          options={METRIC_RANGES.map((value) => ({ value, label: t(`monitor.ranges.${value}`) }))}
          className="w-48"
        />
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          {status === "connecting" ? <span>{t("monitor.connecting")}</span> : null}
          {status === "retrying" ? <span role="status">{t("monitor.paused")}</span> : null}
          <SimulatedBadge source={snapshot?.source} />
        </div>
      </div>

      <div
        className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-5"
        data-testid="monitor-tiles"
      >
        <StatTile
          label={t("monitor.cpu")}
          value={
            typeof point?.cpuPercent === "number"
              ? formatPercent(point.cpuPercent, language, 1)
              : "—"
          }
          detail={
            snapshot?.cpuCores
              ? t("monitor.coreCount", { count: snapshot.cpuCores.length })
              : undefined
          }
        />
        <StatTile
          label={t("monitor.memory")}
          value={memoryPercent !== null ? formatPercent(memoryPercent, language) : "—"}
          detail={
            typeof point?.memoryUsedBytes === "number" && typeof point.memoryTotalBytes === "number"
              ? t("monitor.usedOf", {
                  used: formatBytes(point.memoryUsedBytes, language),
                  total: formatBytes(point.memoryTotalBytes, language),
                })
              : undefined
          }
        />
        <StatTile
          label={t("monitor.load")}
          value={snapshot?.load ? formatNumber(snapshot.load[0], language, 2) : "—"}
          detail={
            snapshot?.load
              ? t("monitor.loadValue", {
                  one: formatNumber(snapshot.load[0], language, 2),
                  five: formatNumber(snapshot.load[1], language, 2),
                  fifteen: formatNumber(snapshot.load[2], language, 2),
                })
              : undefined
          }
        />
        <StatTile
          label={t("monitor.temperature")}
          value={
            typeof point?.temperatureC === "number"
              ? formatCelsius(point.temperatureC, language)
              : "—"
          }
          detail={
            point && typeof point.temperatureC !== "number" ? t("monitor.notMeasurable") : undefined
          }
        />
        <StatTile
          label={t("monitor.uptime")}
          value={snapshot ? formatDuration(snapshot.uptimeSeconds, language) : "—"}
        />
      </div>

      {range !== "15m" ? <ResourceError error={history.error} /> : null}

      <div className="grid gap-3 @3xl:grid-cols-2">
        <ChartCard
          title={t("monitor.cpu")}
          headline={
            typeof point?.cpuPercent === "number"
              ? formatPercent(point.cpuPercent, language, 1)
              : "—"
          }
          emptyLabel={t("monitor.noData")}
          chart={{
            ...chartBase,
            label: t("monitor.chartLabel", { name: t("monitor.cpu"), range: rangeLabel }),
            yMax: 100,
            formatValue: (value) => formatPercent(value, language, 1),
            formatTick: (value) => formatPercent(value, language),
            series: [
              {
                id: "cpu",
                label: t("monitor.cpu"),
                color: "var(--otk-chart-1)",
                values: column(points, (p) => p.cpuPercent),
              },
            ],
          }}
        />
        <ChartCard
          title={t("monitor.memory")}
          headline={
            typeof point?.memoryUsedBytes === "number"
              ? formatBytes(point.memoryUsedBytes, language)
              : "—"
          }
          emptyLabel={t("monitor.noData")}
          chart={{
            ...chartBase,
            label: t("monitor.chartLabel", { name: t("monitor.memory"), range: rangeLabel }),
            ...(point?.memoryTotalBytes ? { yMax: point.memoryTotalBytes } : {}),
            tickBase: 1024,
            formatValue: (value) => formatBytes(value, language),
            series: [
              {
                id: "memory",
                label: t("monitor.memory"),
                color: "var(--otk-chart-1)",
                values: column(points, (p) => p.memoryUsedBytes),
              },
            ],
          }}
        />
        <ChartCard
          title={t("monitor.netTraffic")}
          emptyLabel={
            point && typeof point.netRxBytesPerSec !== "number" && snapshot?.interfaces === null
              ? t("monitor.notMeasurable")
              : t("monitor.noData")
          }
          chart={{
            ...chartBase,
            label: t("monitor.chartLabel", { name: t("monitor.netTraffic"), range: rangeLabel }),
            formatValue: rate,
            formatTick: (value) => formatBytes(value, language),
            tickBase: 1024,
            series: [
              {
                id: "rx",
                label: t("monitor.download"),
                color: "var(--otk-chart-1)",
                values: column(points, (p) => p.netRxBytesPerSec),
              },
              {
                id: "tx",
                label: t("monitor.upload"),
                color: "var(--otk-chart-2)",
                values: column(points, (p) => p.netTxBytesPerSec),
              },
            ],
          }}
        />
        <ChartCard
          title={t("monitor.diskActivity")}
          emptyLabel={snapshot?.disks === null ? t("monitor.notMeasurable") : t("monitor.noData")}
          chart={{
            ...chartBase,
            label: t("monitor.chartLabel", { name: t("monitor.diskActivity"), range: rangeLabel }),
            formatValue: rate,
            formatTick: (value) => formatBytes(value, language),
            tickBase: 1024,
            series: [
              {
                id: "read",
                label: t("monitor.read"),
                color: "var(--otk-chart-1)",
                values: column(points, (p) => p.diskReadBytesPerSec),
              },
              {
                id: "write",
                label: t("monitor.write"),
                color: "var(--otk-chart-2)",
                values: column(points, (p) => p.diskWriteBytesPerSec),
              },
            ],
          }}
        />
      </div>
    </div>
  );
}
