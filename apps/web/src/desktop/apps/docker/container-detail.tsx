import type {
  ContainerAction,
  ContainerDetail,
  ContainerLogLine,
  ContainerStatsHistory,
  ContainerStatsPoint,
  DockerOwnership,
} from "@everyos/shared";
import { isErrorCode } from "@everyos/shared";
import { ArrowLeft, Lock, Pause, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChartCard } from "../../../components/charts/chart-card.tsx";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useLiveDocker } from "../../../features/docker/live-docker.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { formatBytes, formatClock, formatDateTime, formatPercent } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import {
  DefinitionRows,
  LoadingBlock,
  ResourceError,
  SectionTitle,
  SimulatedBadge,
} from "../system/parts.tsx";
import { dockerErrorMessage, HealthBadge, OwnershipBadge, StateBadge } from "./badges.tsx";

type Detail = ContainerDetail & { ownership: DockerOwnership };
const SECTIONS = ["overview", "stats", "logs"] as const;
type Section = (typeof SECTIONS)[number];
const MAX_LOG_LINES = 2_000;

function Overview({ detail }: { detail: Detail }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const date = (value: number | null) => (value ? formatDateTime(value, language) : "—");
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("docker.detail.risks")}</SectionTitle>
        {detail.risks.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <ShieldCheck className="size-4 text-success" aria-hidden />
            {t("docker.detail.noRisks")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="container-risks">
            {detail.risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2 text-sm">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {t(`docker.risks.${risk}`)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <DefinitionRows
        rows={[
          [
            t("docker.detail.image"),
            <span key="image" className="break-all font-mono text-xs">
              {detail.image}
            </span>,
          ],
          ...(detail.project
            ? ([
                [t("docker.detail.project"), detail.project],
                [t("docker.detail.service"), detail.service ?? "—"],
              ] as Array<[string, string]>)
            : []),
          [t("docker.detail.created"), date(detail.createdAt)],
          [t("docker.detail.started"), date(detail.startedAt)],
          ...(detail.state !== "running"
            ? ([
                [t("docker.detail.finished"), date(detail.finishedAt)],
                [t("docker.detail.exitCode"), detail.exitCode ?? "—"],
              ] as Array<[string, string | number]>)
            : []),
          ...(detail.oomKilled
            ? ([[t("docker.detail.oomKilled"), "✓"]] as Array<[string, string]>)
            : []),
          [t("docker.detail.restartPolicy"), detail.restartPolicy ?? "—"],
          [t("docker.detail.restartCount"), detail.restartCount],
          [
            t("docker.detail.command"),
            detail.command ? (
              <span key="cmd" className="break-all font-mono text-xs">
                {detail.command}
              </span>
            ) : (
              <span key="cmd" className="text-xs text-fg-subtle">
                {t("docker.detail.commandHidden")}
              </span>
            ),
          ],
          [t("docker.detail.user"), detail.user ?? "—"],
          [
            t("docker.detail.memoryLimit"),
            detail.limits.memoryBytes
              ? formatBytes(detail.limits.memoryBytes, language)
              : t("docker.detail.unlimited"),
          ],
          [
            t("docker.detail.cpuLimit"),
            detail.limits.cpus
              ? t("docker.detail.cpus", { count: detail.limits.cpus })
              : t("docker.detail.unlimited"),
          ],
        ]}
      />
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("docker.detail.ports")}</SectionTitle>
        {detail.ports.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("docker.detail.noPorts")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
            {detail.ports.map((port) => (
              <li
                key={`${port.privatePort}/${port.type}/${port.publicPort ?? ""}`}
                className="glass-inset rounded-everyos-sm px-2 py-1"
              >
                {port.publicPort !== null ? `${port.publicPort} → ` : ""}
                {port.privatePort}/{port.type}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("docker.detail.networks")}</SectionTitle>
        <DefinitionRows rows={detail.networkDetails.map((n) => [n.name, n.ipAddress ?? "—"])} />
      </section>
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("docker.detail.mounts")}</SectionTitle>
        {detail.mounts.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("docker.detail.noMounts")}</p>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {detail.mounts.map((mount) => (
              <li key={`${mount.destination}-${mount.source ?? ""}`} className="break-all">
                <span className="text-fg-subtle">{mount.type}</span> {mount.source ?? "—"} →{" "}
                {mount.destination}
                {mount.readOnly ? (
                  <span className="font-sans text-fg-subtle"> ({t("docker.detail.readOnly")})</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("docker.detail.env")}</SectionTitle>
        <p className="text-xs text-fg-subtle">{t("docker.detail.envHelp")}</p>
        <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
          {detail.envKeys.map((key) => (
            <li key={key} className="glass-inset rounded-everyos-sm px-2 py-0.5">
              {key}
            </li>
          ))}
        </ul>
      </section>
      {detail.healthLog.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>{t("docker.detail.healthLog")}</SectionTitle>
          <ul className="flex flex-col gap-1 text-xs">
            {detail.healthLog.map((entry, index) => (
              <li key={index} className="flex gap-2">
                <span className="tabular-nums text-fg-muted">
                  {entry.at ? formatClock(entry.at, language, true) : "—"}
                </span>
                <span
                  className={cn(
                    "font-semibold",
                    entry.exitCode === 0 ? "text-success" : "text-danger",
                  )}
                >
                  {entry.exitCode === 0 ? "✓" : `✗ ${entry.exitCode ?? ""}`}
                </span>
                <span className="min-w-0 break-words font-mono">{entry.output || "—"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {Object.keys(detail.labels).length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-fg-muted">
            {t("docker.detail.labels")} ({Object.keys(detail.labels).length})
          </summary>
          <dl className="mt-2 grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            {Object.entries(detail.labels).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="break-all text-fg-muted">{key}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function Stats({ id, running }: { id: string; running: boolean }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const live = useLiveDocker((state) => state.stats?.containers[id]);
  const history = useApiResource<ContainerStatsHistory>(
    running ? `/docker/containers/${id}/stats` : null,
    30_000,
  );
  if (!running) return <p className="text-sm text-fg-muted">{t("docker.stats.notRunning")}</p>;
  const byTime = new Map<number, ContainerStatsPoint>();
  for (const point of history.data?.points ?? []) byTime.set(point.at, point);
  if (live) byTime.set(live.at, live);
  const points = [...byTime.values()].sort((a, b) => a.at - b.at);
  if (points.length === 0) return <LoadingBlock />;
  const times = points.map((p) => p.at);
  const end = times.at(-1) ?? 0;
  const base = {
    times,
    domain: [end - 15 * 60_000, end] as const,
    formatTime: (time: number) => formatClock(time, language),
    maxGapMs: 30_000,
    height: 130,
  };
  const rate = (value: number) => t("monitor.perSecond", { value: formatBytes(value, language) });
  const latest = points.at(-1)!;
  return (
    <div className="grid gap-3 @3xl:grid-cols-2" data-testid="container-stats">
      <ChartCard
        title={t("docker.stats.cpu")}
        headline={latest.cpuPercent !== null ? formatPercent(latest.cpuPercent, language, 1) : "—"}
        emptyLabel={t("docker.stats.waiting")}
        chart={{
          ...base,
          label: t("monitor.chartLabel", {
            name: t("docker.stats.cpu"),
            range: t("monitor.ranges.15m"),
          }),
          formatValue: (value) => formatPercent(value, language, 1),
          formatTick: (value) => formatPercent(value, language),
          series: [
            {
              id: "cpu",
              label: t("docker.stats.cpu"),
              color: "var(--everyos-chart-1)",
              values: points.map((p) => p.cpuPercent),
            },
          ],
        }}
      />
      <ChartCard
        title={t("docker.stats.memory")}
        headline={
          latest.memoryLimitBytes
            ? t("docker.stats.memoryOf", {
                used: formatBytes(latest.memoryBytes, language),
                limit: formatBytes(latest.memoryLimitBytes, language),
              })
            : formatBytes(latest.memoryBytes, language)
        }
        emptyLabel={t("docker.stats.waiting")}
        chart={{
          ...base,
          label: t("monitor.chartLabel", {
            name: t("docker.stats.memory"),
            range: t("monitor.ranges.15m"),
          }),
          formatValue: (value) => formatBytes(value, language),
          tickBase: 1024,
          series: [
            {
              id: "mem",
              label: t("docker.stats.memory"),
              color: "var(--everyos-chart-1)",
              values: points.map((p) => p.memoryBytes),
            },
          ],
        }}
      />
      <ChartCard
        title={t("docker.stats.network")}
        emptyLabel={t("monitor.notMeasurable")}
        chart={{
          ...base,
          label: t("monitor.chartLabel", {
            name: t("docker.stats.network"),
            range: t("monitor.ranges.15m"),
          }),
          formatValue: rate,
          formatTick: (value) => formatBytes(value, language),
          tickBase: 1024,
          series: [
            {
              id: "rx",
              label: t("monitor.download"),
              color: "var(--everyos-chart-1)",
              values: points.map((p) => p.netRxBytesPerSec),
            },
            {
              id: "tx",
              label: t("monitor.upload"),
              color: "var(--everyos-chart-2)",
              values: points.map((p) => p.netTxBytesPerSec),
            },
          ],
        }}
      />
      <ChartCard
        title={t("docker.stats.disk")}
        emptyLabel={t("monitor.notMeasurable")}
        chart={{
          ...base,
          label: t("monitor.chartLabel", {
            name: t("docker.stats.disk"),
            range: t("monitor.ranges.15m"),
          }),
          formatValue: rate,
          formatTick: (value) => formatBytes(value, language),
          tickBase: 1024,
          series: [
            {
              id: "read",
              label: t("monitor.read"),
              color: "var(--everyos-chart-1)",
              values: points.map((p) => p.blockReadBytesPerSec),
            },
            {
              id: "write",
              label: t("monitor.write"),
              color: "var(--everyos-chart-2)",
              values: points.map((p) => p.blockWriteBytesPerSec),
            },
          ],
        }}
      />
    </div>
  );
}

const TAILS = ["100", "500", "2000"] as const;

function Logs({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const [tail, setTail] = useState<(typeof TAILS)[number]>("100");
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<ContainerLogLine[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [key, setKey] = useState(`${id}|${tail}|${follow}|0`);
  const bottom = useRef<HTMLDivElement>(null);
  const current = `${id}|${tail}|${follow}|${attempt}`;
  if (key !== current) {
    setKey(current);
    setLines([]);
    setEnded(false);
    setError(null);
  }

  useEffect(() => {
    const events = new EventSource(
      `/api/docker/containers/${id}/logs?tail=${tail}&follow=${follow}`,
    );
    events.addEventListener("ready", () => setError(null));
    events.addEventListener("line", (event) => {
      const line = JSON.parse((event as MessageEvent<string>).data) as ContainerLogLine;
      setLines((existing) => [...existing, line].slice(-MAX_LOG_LINES));
    });
    events.addEventListener("end", () => {
      setEnded(true);
      events.close();
    });
    events.addEventListener("error", (event) => {
      // Native transport errors have no data; the API also sends a named error event.
      if (!(event instanceof MessageEvent)) return;
      let code: unknown;
      try {
        code = (JSON.parse(event.data as string) as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      setError(new ApiRequestError(0, isErrorCode(code) ? code : "UNKNOWN", "Log stream failed"));
      setEnded(true);
      events.close();
    });
    events.onerror = (event) => {
      if (event instanceof MessageEvent) return;
      setError(new ApiRequestError(0, "NETWORK", "Log connection interrupted"));
      if (events.readyState === EventSource.CLOSED) setEnded(true);
    };
    return () => events.close();
  }, [id, tail, follow, attempt]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [lines, follow]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t("docker.logs.tail")}
          value={tail}
          onChange={setTail}
          options={TAILS.map((value) => ({ value, label: value }))}
          className="w-32"
        />
        <Button
          variant={follow ? "primary" : "secondary"}
          aria-pressed={follow}
          onClick={() => setFollow((value) => !value)}
          data-testid="docker-logs-follow"
        >
          {follow ? (
            <Pause className="size-4" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          {t("docker.logs.follow")}
        </Button>
        {ended || error ? (
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        ) : null}
      </div>
      <ResourceError error={error} />
      <div
        className="glass-inset max-h-[28rem] min-h-40 overflow-auto rounded-everyos-md p-2"
        data-testid="docker-logs"
      >
        {lines.length === 0 ? (
          <p className="p-4 text-center text-sm text-fg-muted">
            {ended || error ? t("docker.logs.empty") : t("common.loading")}
          </p>
        ) : (
          <ol className="font-mono text-xs leading-relaxed">
            {lines.map((line, index) => (
              <li key={index} className="grid grid-cols-[4.5rem_2.5rem_minmax(0,1fr)] gap-x-2">
                <time className="tabular-nums text-fg-subtle">
                  {line.ts ? formatClock(line.ts, i18n.language, true) : ""}
                </time>
                <span
                  className={
                    line.stream === "stderr" ? "font-semibold text-danger" : "text-fg-subtle"
                  }
                >
                  {line.stream === "stderr" ? "err" : "out"}
                </span>
                <span className="whitespace-pre-wrap break-words text-fg">{line.line}</span>
              </li>
            ))}
          </ol>
        )}
        <div ref={bottom} />
      </div>
      {ended && follow ? <p className="text-xs text-fg-subtle">{t("docker.logs.ended")}</p> : null}
    </div>
  );
}

export function ContainerDetailPanel({
  id,
  onBack,
  onChanged,
  refreshKey,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
  refreshKey: number;
}) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.includes("docker:manage");
  const canReadLogs = permissions.includes("logs:read");
  const detail = useApiResource<Detail>(`/docker/containers/${id}`, 15_000, refreshKey);
  const [section, setSection] = useState<Section>("overview");
  const [pending, setPending] = useState<ContainerAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const data = detail.data;

  const run = async (action: ContainerAction) => {
    const label = t(`docker.actions.${action}`);
    if (action !== "start") {
      const ok = await requestConfirm({
        title: t("docker.confirmTitle", { name: data?.name ?? id.slice(0, 12), action: label }),
        body: t(`docker.confirmBody.${action}`),
        confirmLabel: label,
        danger: action === "stop",
      });
      if (!ok) return;
    }
    setPending(action);
    setActionError(null);
    setNotice(null);
    try {
      await api(`/docker/containers/${id}/actions`, { method: "POST", body: { action } });
      setNotice(t("docker.submitted", { action: label }));
      detail.reload();
      onChanged();
    } catch (error) {
      setActionError(error);
    } finally {
      setPending(null);
    }
  };

  const actions: ContainerAction[] = data
    ? data.state === "running"
      ? data.protected
        ? []
        : ["restart", "stop"]
      : ["start"]
    : [];
  const sections = SECTIONS.filter((s) => s !== "logs" || canReadLogs);

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4"
      data-testid="container-detail"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onBack}
          className="grid size-8 shrink-0 place-items-center rounded-everyos-sm text-fg-muted outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent @3xl:hidden"
          aria-label={t("common.back")}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 break-all text-base font-semibold">
            {data?.name ?? id.slice(0, 12)}
            {data?.protected ? (
              <Lock className="size-4 shrink-0 text-fg-muted" aria-label={t("docker.protected")} />
            ) : null}
          </h2>
          {data ? <p className="break-all font-mono text-xs text-fg-muted">{data.image}</p> : null}
        </div>
        <SimulatedBadge source={data?.source} />
      </div>
      <ResourceError error={detail.error} />
      {detail.loading ? <LoadingBlock /> : null}
      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={data.state} />
            <HealthBadge health={data.health} />
            <OwnershipBadge ownership={data.ownership} />
          </div>
          {data.protected ? <Alert tone="info">{t("docker.protectedHelp")}</Alert> : null}
          {canManage && actions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={
                    action === "stop" ? "danger" : action === "start" ? "primary" : "secondary"
                  }
                  loading={pending === action}
                  disabled={pending !== null}
                  onClick={() => void run(action)}
                >
                  {t(`docker.actions.${action}`)}
                </Button>
              ))}
            </div>
          ) : null}
          {!canManage ? <p className="text-xs text-fg-subtle">{t("docker.readOnlyHint")}</p> : null}
          {notice ? (
            <p role="status" className="text-sm text-fg-muted">
              {notice}
            </p>
          ) : null}
          {actionError ? <Alert tone="danger">{dockerErrorMessage(t, actionError)}</Alert> : null}
          <div role="tablist" aria-label={data.name} className="flex gap-1 border-b border-line">
            {sections.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={section === id}
                onClick={() => setSection(id)}
                className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent aria-selected:border-accent aria-selected:font-semibold aria-selected:text-fg"
              >
                {t(`docker.detail.sections.${id}`)}
              </button>
            ))}
          </div>
          {section === "overview" ? <Overview detail={data} /> : null}
          {section === "stats" ? <Stats id={data.id} running={data.state === "running"} /> : null}
          {section === "logs" && canReadLogs ? <Logs id={data.id} /> : null}
        </>
      ) : null}
    </div>
  );
}
