import type { ContainerState, HealthState, LocalizedText } from "@everyos/shared";
import { Boxes } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLiveDocker, useLiveDockerSubscription } from "../../../features/docker/live-docker.ts";
import { formatBytes, formatNumber, formatPercent } from "../../../lib/format.ts";
import { localized } from "../../apps/store/parts.tsx";
import { StateBadge } from "../../apps/docker/badges.tsx";
import { Row, Rows, Status, Value } from "../templates.tsx";
import { StateActions } from "../instance.tsx";
import { useTopic } from "../topics.ts";
import { Placeholder, TopicGate, type WidgetRenderProps } from "./gate.tsx";

/** `data.docker`: container states (no stats) plus installed apps for users with apps:read. */
export interface DockerData {
  source: "host" | "simulated";
  containers: Array<{
    id: string;
    name: string;
    image: string;
    state: ContainerState;
    health: HealthState;
    status: string;
    project: string | null;
  }>;
  apps: Array<{ id: string; name: LocalizedText; project: string }>;
}

export function useDockerData() {
  return useTopic<DockerData>("data.docker");
}

export function DockerSummaryWidget({ compact, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const state = useDockerData();
  return (
    <TopicGate state={state} compact={compact}>
      {(docker) => {
        const running = docker.containers.filter((c) => c.state === "running").length;
        const unhealthy = docker.containers.filter((c) => c.health === "unhealthy").length;
        const stopped = docker.containers.filter(
          (c) => c.state === "exited" || c.state === "dead",
        ).length;
        if (compact)
          return (
            <span className="flex items-center gap-1 whitespace-nowrap tabular-nums">
              <Boxes className="size-3.5 text-fg-muted" aria-hidden />
              {formatNumber(running, i18n.language)}/
              {formatNumber(docker.containers.length, i18n.language)}
            </span>
          );
        return (
          <div className="flex h-full flex-col gap-2">
            <Value
              label={t("widgets.text.runningContainers")}
              value={`${formatNumber(running, i18n.language)} / ${formatNumber(docker.containers.length, i18n.language)}`}
            />
            <Rows>
              {unhealthy > 0 ? (
                <li>
                  <Status tone="critical">
                    {t(
                      size === "small"
                        ? "widgets.text.unhealthyShort"
                        : "widgets.text.unhealthyCount",
                      {
                        count: unhealthy,
                      },
                    )}
                  </Status>
                </li>
              ) : (
                <li>
                  <Status tone="ok">{t("widgets.text.noUnhealthy")}</Status>
                </li>
              )}
              {/* Small tiles show the headline and health only. */}
              {size !== "small" ? (
                <>
                  <Row
                    label={t("widgets.text.stopped")}
                    value={formatNumber(stopped, i18n.language)}
                  />
                  <Row
                    label={t("widgets.text.projects")}
                    value={formatNumber(
                      new Set(docker.containers.map((c) => c.project).filter(Boolean)).size,
                      i18n.language,
                    )}
                  />
                </>
              ) : null}
            </Rows>
          </div>
        );
      }}
    </TopicGate>
  );
}

export function DockerResourcesWidget({ instance, compact }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  useLiveDockerSubscription();
  const stats = useLiveDocker((state) => state.stats);
  const state = useDockerData();
  const sort = instance.config.sort === "memory" ? "memory" : "cpu";
  const count = typeof instance.config.count === "number" ? instance.config.count : 5;
  return (
    <TopicGate state={state} compact={compact}>
      {(docker) => {
        if (!stats)
          return (
            <Placeholder compact={compact} busy>
              {t("common.loading")}
            </Placeholder>
          );
        const rows = docker.containers
          .filter((c) => c.state === "running" && stats.containers[c.id])
          .map((c) => ({ ...c, point: stats.containers[c.id]! }))
          .sort((a, b) =>
            sort === "cpu"
              ? (b.point.cpuPercent ?? 0) - (a.point.cpuPercent ?? 0)
              : b.point.memoryBytes - a.point.memoryBytes,
          )
          .slice(0, count);
        if (rows.length === 0)
          return <Placeholder compact={compact}>{t("widgets.text.noRunning")}</Placeholder>;
        return (
          <Rows>
            {rows.map((row) => (
              <Row
                key={row.id}
                label={row.name}
                value={
                  sort === "cpu"
                    ? row.point.cpuPercent === null
                      ? "—"
                      : formatPercent(row.point.cpuPercent, i18n.language, 1)
                    : formatBytes(row.point.memoryBytes, i18n.language)
                }
              />
            ))}
          </Rows>
        );
      }}
    </TopicGate>
  );
}

/** Containers behind a target: "app:<id>", "project:<name>" or "container:<name>". */
export function resolveDockerTarget(
  target: string,
  docker: DockerData,
): {
  kind: "app" | "project" | "container";
  name: string;
  containers: DockerData["containers"];
  missingApp: boolean;
} {
  const [kind, ...rest] = target.split(":");
  const value = rest.join(":");
  if (kind === "app") {
    const app = docker.apps.find((a) => a.id === value);
    return {
      kind: "app",
      name: value,
      containers: app ? docker.containers.filter((c) => c.project === app.project) : [],
      missingApp: !app,
    };
  }
  if (kind === "project")
    return {
      kind: "project",
      name: value,
      containers: docker.containers.filter((c) => c.project === value),
      missingApp: false,
    };
  return {
    kind: "container",
    name: value,
    containers: docker.containers.filter((c) => c.name === value),
    missingApp: false,
  };
}

export function DockerAppWidget({ instance, compact, size }: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  useLiveDockerSubscription();
  const stats = useLiveDocker((state) => state.stats);
  const state = useDockerData();
  const target = typeof instance.config.target === "string" ? instance.config.target : "";
  return (
    <TopicGate state={state} compact={compact}>
      {(docker) => {
        const resolved = resolveDockerTarget(target, docker);
        if (resolved.missingApp)
          return (
            <Placeholder compact={compact}>
              {t("widgets.reasons.app-removed")}
              {!compact ? <StateActions remove /> : null}
            </Placeholder>
          );
        if (resolved.containers.length === 0)
          return <Placeholder compact={compact}>{t("widgets.text.targetMissing")}</Placeholder>;
        const app =
          resolved.kind === "app" ? docker.apps.find((a) => a.id === resolved.name) : undefined;
        const title = app ? localized(app.name, i18n.language) || resolved.name : resolved.name;
        const running = resolved.containers.filter((c) => c.state === "running");
        const unhealthy = resolved.containers.some((c) => c.health === "unhealthy");
        const points = running.map((c) => stats?.containers[c.id]).filter((p) => p !== undefined);
        const cpu = points.length ? points.reduce((sum, p) => sum + (p.cpuPercent ?? 0), 0) : null;
        const memory = points.length ? points.reduce((sum, p) => sum + p.memoryBytes, 0) : null;
        return (
          <div className="flex h-full flex-col gap-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">{title}</span>
              {running.length > 0 && running.length < resolved.containers.length ? (
                <Status tone="warning">
                  {t("widgets.text.partlyRunning", {
                    running: running.length,
                    total: resolved.containers.length,
                  })}
                </Status>
              ) : (
                <StateBadge
                  state={running.length > 0 ? "running" : resolved.containers[0]!.state}
                />
              )}
            </div>
            {unhealthy ? <Status tone="critical">{t("docker.health.unhealthy")}</Status> : null}
            <Rows>
              <Row
                label={t("monitor.cpu")}
                value={cpu === null ? "—" : formatPercent(cpu, i18n.language, 1)}
              />
              <Row
                label={t("monitor.memory")}
                value={memory === null ? "—" : formatBytes(memory, i18n.language)}
              />
              {size !== "small"
                ? resolved.containers
                    .slice(0, 4)
                    .map((c) => (
                      <Row
                        key={c.id}
                        label={<span className="font-mono">{c.name}</span>}
                        value={t(`docker.states.${c.state}`)}
                      />
                    ))
                : null}
            </Rows>
          </div>
        );
      }}
    </TopicGate>
  );
}
