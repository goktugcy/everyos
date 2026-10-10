import type {
  AptUpdates,
  HardwareStatus,
  NetworkStatus,
  SocketSummary,
  StorageUsage,
  AlertSummary,
  TailscaleStatus,
  TimerSummary,
} from "@otuken/shared";
import { AlertTriangle, ArrowDown, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  useLiveMetrics,
  useLiveMetricsSubscription,
} from "../../../features/metrics/live-metrics.ts";
import {
  formatBytes,
  formatCelsius,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../../../lib/format.ts";
import { Bar, Row, Rows, Sparkline, Status, Value } from "../templates.tsx";
import { useReportSource } from "../instance.tsx";
import { useTopic } from "../topics.ts";
import { Placeholder, TopicGate, type WidgetRenderProps } from "./gate.tsx";

const TREND = 40;

/** Live metrics shared with the System Monitor and the menu bar (one stream per tab). */
function useMetrics() {
  useLiveMetricsSubscription();
  const snapshot = useLiveMetrics((state) => state.snapshot);
  useReportSource(snapshot?.source);
  const points = useLiveMetrics((state) => state.points);
  return { snapshot, point: snapshot?.point ?? null, trend: points.slice(-TREND) };
}

function Compact({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-fg-muted">{label}</span> {value}
    </span>
  );
}

function Layout({
  children,
  size,
}: {
  children: React.ReactNode;
  size: WidgetRenderProps["size"];
}) {
  return (
    <div
      className={
        size === "small"
          ? "flex h-full flex-col justify-between gap-1"
          : "flex h-full flex-col gap-2"
      }
    >
      {children}
    </div>
  );
}

export function CpuWidget({ instance, compact, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { snapshot, point, trend } = useMetrics();
  const value = point?.cpuPercent ?? null;
  if (compact)
    return (
      <Compact
        label={t("widgets.text.cpu")}
        value={value === null ? "—" : formatPercent(value, i18n.language)}
      />
    );
  if (!snapshot)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  return (
    <Layout size={size}>
      <Value
        value={value === null ? "—" : formatPercent(value, i18n.language, 1)}
        detail={
          snapshot.cpuCores
            ? t("monitor.coreCount", { count: snapshot.cpuCores.length })
            : undefined
        }
      />
      {instance.config.chart !== false ? (
        <Sparkline values={trend.map((p) => p.cpuPercent)} max={100} />
      ) : null}
      {size === "large" && snapshot.cpuCores ? (
        <Rows>
          {snapshot.cpuCores.map((core, index) => (
            <li key={index} className="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
              <span className="text-fg-muted">{t("monitor.hardware.core", { n: index })}</span>
              <Bar percent={core} warnAt={101} dangerAt={101} />
              <span className="text-right tabular-nums">{formatPercent(core, i18n.language)}</span>
            </li>
          ))}
        </Rows>
      ) : null}
    </Layout>
  );
}

export function CpuFrequencyWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { snapshot } = useMetrics();
  const frequencies = snapshot?.cpuFrequencyMHz ?? null;
  const average = frequencies?.length
    ? frequencies.reduce((a, b) => a + b, 0) / frequencies.length
    : null;
  const text = average === null ? "—" : `${formatNumber(average, i18n.language)} MHz`;
  if (compact) return <Compact label={t("widgets.text.frequency")} value={text} />;
  if (!snapshot)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (!frequencies) return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <div className="flex h-full flex-col gap-2">
      <Value value={text} detail={t("widgets.text.average")} />
      <Rows>
        {frequencies.slice(0, 8).map((mhz, index) => (
          <Row
            key={index}
            label={t("monitor.hardware.core", { n: index })}
            value={`${formatNumber(mhz, i18n.language)} MHz`}
          />
        ))}
      </Rows>
    </div>
  );
}

function TemperatureView({
  compact,
  size,
  instance,
  zone,
}: WidgetRenderProps & { zone: "preferred" | "soc" }) {
  const { t, i18n } = useTranslation();
  const { snapshot, point, trend } = useMetrics();
  const soc = snapshot?.thermal?.find((z) => /cpu|soc/i.test(z.type))?.celsius ?? null;
  const value = zone === "soc" ? soc : (point?.temperatureC ?? null);
  const text = value === null ? "—" : formatCelsius(value, i18n.language);
  if (compact) return <Compact label={t("widgets.text.temperature")} value={text} />;
  if (!snapshot)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (value === null)
    return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <Layout size={size}>
      <Value
        value={text}
        detail={
          value >= 80 ? (
            <Status tone="critical">{t("widgets.text.hot")}</Status>
          ) : value >= 70 ? (
            <Status tone="warning">{t("widgets.text.warm")}</Status>
          ) : undefined
        }
      />
      {instance.config.chart !== false ? (
        <Sparkline values={trend.map((p) => p.temperatureC)} max={90} />
      ) : null}
    </Layout>
  );
}

export const TemperatureWidget = (props: WidgetRenderProps) => (
  <TemperatureView {...props} zone="preferred" />
);
export const SocTemperatureWidget = (props: WidgetRenderProps) => (
  <TemperatureView {...props} zone="soc" />
);

export function MemoryWidget({ instance, compact, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { point, trend } = useMetrics();
  const used = point?.memoryUsedBytes ?? null;
  const total = point?.memoryTotalBytes ?? null;
  const percent = used !== null && total ? (used / total) * 100 : null;
  if (compact)
    return (
      <Compact
        label={t("widgets.text.memory")}
        value={percent === null ? "—" : formatPercent(percent, i18n.language)}
      />
    );
  if (!point)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  return (
    <Layout size={size}>
      <Value
        value={percent === null ? "—" : formatPercent(percent, i18n.language)}
        detail={
          used !== null && total !== null
            ? t("monitor.usedOf", {
                used: formatBytes(used, i18n.language),
                total: formatBytes(total, i18n.language),
              })
            : undefined
        }
      />
      {instance.config.chart !== false ? (
        <Sparkline
          values={trend.map((p) =>
            p.memoryUsedBytes !== null && p.memoryTotalBytes
              ? (p.memoryUsedBytes / p.memoryTotalBytes) * 100
              : null,
          )}
          max={100}
        />
      ) : percent !== null ? (
        <Bar percent={percent} />
      ) : null}
    </Layout>
  );
}

export function SwapWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { point } = useMetrics();
  const used = point?.swapUsedBytes ?? null;
  const total = point?.swapTotalBytes ?? null;
  const percent = used !== null && total ? (used / total) * 100 : null;
  if (compact)
    return (
      <Compact
        label={t("widgets.text.swap")}
        value={percent === null ? "—" : formatPercent(percent, i18n.language)}
      />
    );
  if (!point)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (!total) return <Placeholder compact={false}>{t("widgets.text.noSwap")}</Placeholder>;
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <Value
        value={formatPercent(percent ?? 0, i18n.language)}
        detail={t("monitor.usedOf", {
          used: formatBytes(used ?? 0, i18n.language),
          total: formatBytes(total, i18n.language),
        })}
      />
      <Bar percent={percent ?? 0} />
    </div>
  );
}

function usage(mount: StorageUsage["mounts"][number]) {
  const total = mount.usedBytes + mount.availableBytes;
  return total > 0 ? (mount.usedBytes / total) * 100 : 0;
}

export function DiskUsageWidget({ instance, compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useTopic<StorageUsage>("data.storage");
  const mountpoint = typeof instance.config.mount === "string" ? instance.config.mount : "/";
  return (
    <TopicGate state={state} compact={compact}>
      {(storage) => {
        const mount = storage.mounts.find((m) => m.mountpoint === mountpoint) ?? storage.mounts[0];
        if (!mount)
          return <Placeholder compact={compact}>{t("monitor.storage.empty")}</Placeholder>;
        const percent = usage(mount);
        if (compact)
          return <Compact label={mount.mountpoint} value={formatPercent(percent, i18n.language)} />;
        return (
          <div className="flex h-full flex-col justify-between gap-2">
            <Value
              label={<span className="font-mono">{mount.mountpoint}</span>}
              value={formatPercent(percent, i18n.language)}
              detail={t("monitor.storage.free", {
                free: formatBytes(mount.availableBytes, i18n.language),
              })}
            />
            <Bar percent={percent} />
          </div>
        );
      }}
    </TopicGate>
  );
}

export function MountsWidget({ compact }: WidgetRenderProps) {
  const { i18n } = useTranslation();
  const state = useTopic<StorageUsage>("data.storage");
  return (
    <TopicGate state={state} compact={compact}>
      {(storage) => (
        <Rows className="gap-2">
          {storage.mounts.slice(0, 8).map((mount) => (
            <li key={`${mount.device}-${mount.mountpoint}`} className="flex flex-col gap-1">
              <div className="flex justify-between gap-2">
                <span className="truncate font-mono">{mount.mountpoint}</span>
                <span className="tabular-nums">
                  {formatPercent(usage(mount), i18n.language)} ·{" "}
                  {formatBytes(mount.totalBytes, i18n.language)}
                </span>
              </div>
              <Bar percent={usage(mount)} />
            </li>
          ))}
        </Rows>
      )}
    </TopicGate>
  );
}

function RatePair({ up, down }: { up: string; down: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 tabular-nums">
      <span className="flex items-center gap-0.5">
        <ArrowDown className="size-3.5 text-fg-muted" aria-hidden />
        {down}
      </span>
      <span className="flex items-center gap-0.5">
        <ArrowUp className="size-3.5 text-fg-muted" aria-hidden />
        {up}
      </span>
    </span>
  );
}

function TwoSeries({
  first,
  second,
  firstLabel,
  secondLabel,
}: {
  first: Array<number | null>;
  second: Array<number | null>;
  firstLabel: string;
  secondLabel: string;
}) {
  const max = Math.max(
    1,
    ...first.filter((v): v is number => v !== null),
    ...second.filter((v): v is number => v !== null),
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Sparkline values={first} max={max} />
        <Sparkline
          values={second}
          max={max}
          color="var(--otk-chart-2)"
          className="absolute inset-0"
        />
      </div>
      <div className="flex gap-3 text-[0.7rem] text-fg-muted">
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded-full bg-[var(--otk-chart-1)]" aria-hidden />
          {firstLabel}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded-full bg-[var(--otk-chart-2)]" aria-hidden />
          {secondLabel}
        </span>
      </div>
    </div>
  );
}

export function NetworkWidget({ instance, compact, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { point, trend } = useMetrics();
  const rate = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : t("monitor.perSecond", { value: formatBytes(value, i18n.language) });
  if (compact)
    return <RatePair down={rate(point?.netRxBytesPerSec)} up={rate(point?.netTxBytesPerSec)} />;
  if (!point)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (point.netRxBytesPerSec === null && trend.every((p) => p.netRxBytesPerSec === null))
    return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <Layout size={size}>
      <div className="flex flex-col gap-0.5 text-sm font-semibold">
        <RatePair down={rate(point.netRxBytesPerSec)} up={rate(point.netTxBytesPerSec)} />
      </div>
      {instance.config.chart !== false ? (
        <TwoSeries
          first={trend.map((p) => p.netRxBytesPerSec)}
          second={trend.map((p) => p.netTxBytesPerSec)}
          firstLabel={t("monitor.download")}
          secondLabel={t("monitor.upload")}
        />
      ) : null}
    </Layout>
  );
}

export function DiskIoWidget({ instance, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { point, trend } = useMetrics();
  const rate = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : t("monitor.perSecond", { value: formatBytes(value, i18n.language) });
  if (!point)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (point.diskReadBytesPerSec === null && trend.every((p) => p.diskReadBytesPerSec === null))
    return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <Layout size={size}>
      <Rows>
        <Row label={t("monitor.read")} value={rate(point.diskReadBytesPerSec)} />
        <Row label={t("monitor.write")} value={rate(point.diskWriteBytesPerSec)} />
      </Rows>
      {instance.config.chart !== false ? (
        <TwoSeries
          first={trend.map((p) => p.diskReadBytesPerSec)}
          second={trend.map((p) => p.diskWriteBytesPerSec)}
          firstLabel={t("monitor.read")}
          secondLabel={t("monitor.write")}
        />
      ) : null}
    </Layout>
  );
}

export function InterfacesWidget({ compact }: WidgetRenderProps) {
  const { t } = useTranslation();
  const state = useTopic<NetworkStatus>("data.network");
  return (
    <TopicGate state={state} compact={compact}>
      {(network) => (
        <Rows>
          {network.interfaces
            .filter((nic) => !["loopback", "bridge", "virtual"].includes(nic.kind))
            .slice(0, 8)
            .map((nic) => (
              <Row
                key={nic.name}
                label={
                  <span>
                    <span className="font-mono">{nic.name}</span> ·{" "}
                    {nic.up ? t("monitor.net.up") : t("monitor.net.down")}
                  </span>
                }
                value={
                  <span className="font-mono text-[0.7rem]">
                    {nic.addresses.find((a) => a.family === "ipv4")?.address ?? "—"}
                  </span>
                }
              />
            ))}
        </Rows>
      )}
    </TopicGate>
  );
}

export function PortsWidget({ compact }: WidgetRenderProps) {
  const state = useTopic<SocketSummary>("data.sockets");
  return (
    <TopicGate state={state} compact={compact}>
      {(sockets) => (
        <Rows>
          {sockets.listening.slice(0, 12).map((socket) => (
            <Row
              key={`${socket.protocol}-${socket.address}-${socket.port}`}
              label={
                <span className="font-mono">
                  {socket.port}/{socket.protocol}{" "}
                  <span className="text-fg-subtle">{socket.address}</span>
                </span>
              }
              value={socket.process ?? "—"}
            />
          ))}
        </Rows>
      )}
    </TopicGate>
  );
}

export function ConnectionsWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useTopic<SocketSummary>("data.sockets");
  return (
    <TopicGate state={state} compact={compact}>
      {(sockets) =>
        compact ? (
          <Compact
            label={t("widgets.text.connections")}
            value={formatNumber(sockets.connections.established, i18n.language)}
          />
        ) : (
          <Value
            value={formatNumber(sockets.connections.established, i18n.language)}
            label={t("widgets.text.established")}
            detail={t("widgets.text.listeningCount", { count: sockets.listening.length })}
          />
        )
      }
    </TopicGate>
  );
}

export function TailscaleWidget({ compact }: WidgetRenderProps) {
  const { t } = useTranslation();
  const state = useTopic<TailscaleStatus>("data.tailscale");
  return (
    <TopicGate state={state} compact={compact}>
      {(tailscale) => {
        if (!tailscale.status.available)
          return (
            <Placeholder compact={compact}>
              {t(`system.reasons.${tailscale.status.reason ?? "not-detected"}`)}
            </Placeholder>
          );
        const tone = tailscale.online ? "ok" : "warning";
        const label = tailscale.online
          ? t("monitor.tailscale.online")
          : t("monitor.tailscale.offline");
        if (compact) return <Status tone={tone}>Tailscale</Status>;
        return (
          <div className="flex h-full flex-col gap-1.5">
            <Status tone={tone}>{label}</Status>
            <Rows>
              <Row label={t("monitor.tailscale.hostName")} value={tailscale.hostName ?? "—"} />
              <Row
                label={t("monitor.tailscale.ips")}
                value={<span className="font-mono">{tailscale.ips[0] ?? "—"}</span>}
              />
              <Row
                label={t("monitor.tailscale.peers")}
                value={t("monitor.tailscale.peersValue", {
                  online: tailscale.peers.online,
                  total: tailscale.peers.total,
                })}
              />
            </Rows>
          </div>
        );
      }}
    </TopicGate>
  );
}

export function UptimeWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { snapshot } = useMetrics();
  const seconds = snapshot?.uptimeSeconds ?? null;
  if (compact)
    return (
      <Compact
        label={t("widgets.text.uptime")}
        value={seconds === null ? "—" : formatDuration(seconds, i18n.language)}
      />
    );
  if (seconds === null)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  // Days as the headline, the rest below, so the value fits a small tile.
  const days = Math.floor(seconds / 86_400);
  return (
    <Value
      value={formatDuration(days > 0 ? days * 86_400 : seconds, i18n.language)}
      detail={days > 0 ? formatDuration(seconds % 86_400, i18n.language) : undefined}
    />
  );
}

export function LoadWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { snapshot } = useMetrics();
  const load = snapshot?.load ?? null;
  const n = (v: number) => formatNumber(v, i18n.language, 2);
  if (compact) return <Compact label={t("widgets.text.load")} value={load ? n(load[0]) : "—"} />;
  if (!snapshot)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (!load) return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <Value
      value={n(load[0])}
      detail={t("monitor.loadValue", { one: n(load[0]), five: n(load[1]), fifteen: n(load[2]) })}
    />
  );
}

interface ProcessSummary {
  total: number;
  byCpu: Array<{ pid: number; name: string; cpuPercent: number; memoryBytes: number }>;
  byMemory: Array<{ pid: number; name: string; cpuPercent: number; memoryBytes: number }>;
}

export function ProcessesWidget({ instance, compact }: WidgetRenderProps) {
  const { i18n } = useTranslation();
  const state = useTopic<ProcessSummary>("data.processes");
  const sort = instance.config.sort === "memory" ? "memory" : "cpu";
  const count = typeof instance.config.count === "number" ? instance.config.count : 5;
  return (
    <TopicGate state={state} compact={compact}>
      {(summary) => (
        <Rows>
          {(sort === "cpu" ? summary.byCpu : summary.byMemory).slice(0, count).map((p) => (
            <Row
              key={p.pid}
              label={p.name}
              value={
                sort === "cpu"
                  ? formatPercent(p.cpuPercent, i18n.language, 1)
                  : formatBytes(p.memoryBytes, i18n.language)
              }
            />
          ))}
        </Rows>
      )}
    </TopicGate>
  );
}

export function FansWidget() {
  const { t, i18n } = useTranslation();
  const { snapshot } = useMetrics();
  if (!snapshot)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (!snapshot.fans?.length)
    return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <Rows>
      {snapshot.fans.map((fan) => (
        <Row
          key={fan.name}
          label={fan.name}
          value={t("monitor.hardware.rpm", { rpm: formatNumber(fan.rpm, i18n.language) })}
        />
      ))}
    </Rows>
  );
}

export function SensorsWidget() {
  const { t, i18n } = useTranslation();
  const { snapshot } = useMetrics();
  if (!snapshot)
    return (
      <Placeholder compact={false} busy>
        {t("common.loading")}
      </Placeholder>
    );
  if (!snapshot.thermal?.length)
    return <Placeholder compact={false}>{t("monitor.notMeasurable")}</Placeholder>;
  return (
    <Rows>
      {snapshot.thermal.map((zone) => (
        <Row
          key={zone.zone}
          label={zone.type || zone.zone}
          value={formatCelsius(zone.celsius, i18n.language)}
        />
      ))}
    </Rows>
  );
}

export function NvmeWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useTopic<HardwareStatus>("data.hardware");
  return (
    <TopicGate state={state} compact={compact}>
      {(hardware) => {
        if (!hardware.nvme.status.available)
          return (
            <Placeholder compact={compact}>
              {t(`system.reasons.${hardware.nvme.status.reason ?? "not-detected"}`)}
            </Placeholder>
          );
        return (
          <Rows className="gap-2">
            {hardware.nvme.devices.map((device) => (
              <li key={device.device} className="flex flex-col gap-0.5">
                <div className="flex justify-between gap-2">
                  <span className="font-mono">{device.device}</span>
                  <Status
                    tone={device.healthy === false ? "critical" : device.healthy ? "ok" : "neutral"}
                  >
                    {device.healthy === false
                      ? t("monitor.hardware.unhealthy")
                      : device.healthy
                        ? t("monitor.hardware.healthy")
                        : t("monitor.hardware.unknownHealth")}
                  </Status>
                </div>
                <span className="text-fg-subtle">
                  {device.temperatureC !== null
                    ? formatCelsius(device.temperatureC, i18n.language)
                    : "—"}{" "}
                  · {t("monitor.hardware.wear")}{" "}
                  {device.percentageUsed !== null
                    ? formatPercent(device.percentageUsed, i18n.language)
                    : "—"}
                </span>
              </li>
            ))}
          </Rows>
        );
      }}
    </TopicGate>
  );
}

export function AptWidget({ compact, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useTopic<AptUpdates>("data.apt");
  return (
    <TopicGate state={state} compact={compact}>
      {(apt) => (
        <div className="flex h-full flex-col gap-2">
          <Value
            value={formatNumber(apt.total, i18n.language)}
            label={t("widgets.text.updates")}
            detail={
              apt.security > 0 ? (
                <Status tone="warning">
                  {t("widgets.text.securityUpdates", { count: apt.security })}
                </Status>
              ) : (
                t("widgets.text.listsUpdated", {
                  date: apt.listsUpdatedAt
                    ? formatDateTime(apt.listsUpdatedAt, i18n.language)
                    : "—",
                })
              )
            }
          />
          <Rows>
            {apt.packages.slice(0, size === "small" ? 0 : 4).map((p) => (
              <Row
                key={p.name}
                label={p.name}
                value={
                  p.security ? (
                    <AlertTriangle
                      className="size-3.5 text-warning"
                      aria-label={t("widgets.text.security")}
                    />
                  ) : undefined
                }
              />
            ))}
          </Rows>
        </div>
      )}
    </TopicGate>
  );
}

export function AlertsWidget({ compact }: WidgetRenderProps) {
  const { t } = useTranslation();
  const state = useTopic<AlertSummary>("data.alerts");
  return (
    <TopicGate state={state} compact={compact}>
      {({ alerts }) =>
        alerts.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Status tone="ok">{t("widgets.text.noAlerts")}</Status>
          </div>
        ) : (
          <Rows className="gap-1.5">
            {alerts.slice(0, 10).map((alert, index) => (
              <li key={index}>
                <Status tone={alert.severity === "critical" ? "critical" : "warning"}>
                  {alert.kind === "under-voltage" && alert.subject === "since-boot"
                    ? t("widgets.underVoltagePast")
                    : t(`widgets.alerts.${alert.kind}`, { subject: alert.subject })}
                </Status>
              </li>
            ))}
          </Rows>
        )
      }
    </TopicGate>
  );
}

interface ServiceSummary {
  total: number;
  active: number;
  failed: Array<{ name: string; description: string }>;
}

export function ServicesWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useTopic<ServiceSummary>("data.services");
  return (
    <TopicGate state={state} compact={compact}>
      {(services) =>
        compact ? (
          services.failed.length > 0 ? (
            <Status tone="critical">
              {t("widgets.text.failedCount", { count: services.failed.length })}
            </Status>
          ) : (
            <Status tone="ok">{t("widgets.text.servicesOk")}</Status>
          )
        ) : (
          <div className="flex h-full flex-col gap-2">
            <Value
              value={`${formatNumber(services.active, i18n.language)} / ${formatNumber(services.total, i18n.language)}`}
              label={t("widgets.text.activeServices")}
            />
            {services.failed.length === 0 ? (
              <Status tone="ok">{t("widgets.text.servicesOk")}</Status>
            ) : (
              <Rows>
                {services.failed.slice(0, 5).map((s) => (
                  <li key={s.name}>
                    <Status tone="critical">{s.name}</Status>
                  </li>
                ))}
              </Rows>
            )}
          </div>
        )
      }
    </TopicGate>
  );
}

export function TimersWidget({ compact }: WidgetRenderProps) {
  const { i18n } = useTranslation();
  const state = useTopic<TimerSummary>("data.timers");
  return (
    <TopicGate state={state} compact={compact}>
      {(summary) => (
        <Rows>
          {summary.timers.slice(0, 8).map((timer) => (
            <Row
              key={timer.unit}
              label={<span className="font-mono">{timer.unit.replace(/\.timer$/, "")}</span>}
              value={
                timer.next
                  ? formatDateTime(timer.next, i18n.language, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })
                  : "—"
              }
            />
          ))}
        </Rows>
      )}
    </TopicGate>
  );
}

/* ----------------------------- Raspberry Pi ----------------------------- */

const CURRENT_FLAGS = ["underVoltage", "frequencyCapped", "throttled", "softTempLimit"] as const;

export function ThrottlingWidget({ compact }: WidgetRenderProps) {
  const { t } = useTranslation();
  const state = useTopic<HardwareStatus>("data.hardware");
  return (
    <TopicGate state={state} compact={compact}>
      {(hardware) => {
        const { throttling } = hardware;
        if (!throttling.status.available || !throttling.flags)
          return (
            <Placeholder compact={compact}>
              {t(`system.reasons.${throttling.status.reason ?? "not-detected"}`)}
            </Placeholder>
          );
        const flags = throttling.flags;
        const now = CURRENT_FLAGS.filter((f) => flags[f]);
        const past = CURRENT_FLAGS.filter((f) => !flags[f] && flags[`${f}Occurred`]);
        return (
          <Rows className="gap-1.5">
            {now.length === 0 && past.length === 0 ? (
              <li>
                <Status tone="ok">{t("monitor.hardware.allClear")}</Status>
              </li>
            ) : null}
            {now.map((f) => (
              <li key={f}>
                <Status tone="critical">{t(`monitor.hardware.flags.${f}`)}</Status>
              </li>
            ))}
            {past.map((f) => (
              <li key={f}>
                <Status tone="warning">{t(`monitor.hardware.flags.${f}Occurred`)}</Status>
              </li>
            ))}
          </Rows>
        );
      }}
    </TopicGate>
  );
}

export function UndervoltageWidget({ compact }: WidgetRenderProps) {
  const { t } = useTranslation();
  const state = useTopic<HardwareStatus>("data.hardware");
  return (
    <TopicGate state={state} compact={compact}>
      {(hardware) => {
        const flags = hardware.throttling.flags;
        if (!hardware.throttling.status.available || !flags)
          return (
            <Placeholder compact={compact}>
              {t(`system.reasons.${hardware.throttling.status.reason ?? "not-detected"}`)}
            </Placeholder>
          );
        const status = flags.underVoltage ? (
          <Status tone="critical">{t("monitor.hardware.flags.underVoltage")}</Status>
        ) : flags.underVoltageOccurred ? (
          <Status tone="warning">{t("monitor.hardware.flags.underVoltageOccurred")}</Status>
        ) : (
          <Status tone="ok">{t("widgets.text.powerOk")}</Status>
        );
        return compact ? status : <div className="flex h-full items-center">{status}</div>;
      }}
    </TopicGate>
  );
}

interface SystemSummary {
  hostname: string;
  model: string | null;
  os: string;
  kernel: string;
  arch: string;
  memoryBytes: number;
}

export function ModelWidget({ compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useTopic<SystemSummary>("data.system");
  return (
    <TopicGate state={state} compact={compact}>
      {(system) => (
        <div className="flex h-full flex-col gap-2">
          <Value
            value={<span className="text-base">{system.model ?? t("system.unknown")}</span>}
            detail={system.hostname}
          />
          <Rows>
            <Row label={t("system.os")} value={system.os} />
            <Row
              label={t("system.memory")}
              value={formatBytes(system.memoryBytes, i18n.language)}
            />
          </Rows>
        </div>
      )}
    </TopicGate>
  );
}
