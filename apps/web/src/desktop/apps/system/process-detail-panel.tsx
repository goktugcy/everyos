import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { formatBytes, formatNumber } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { DefinitionRows, LoadingBlock, ResourceError, SimulatedBadge } from "./parts.tsx";
import { ProcessExplanation } from "./process-explanation.tsx";
import type { useProcessInspector } from "./use-process-inspector.tsx";

export function ProcessDetailPanel({
  inspector,
}: {
  inspector: ReturnType<typeof useProcessInspector>;
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const { selected, detail, target } = inspector;
  if (!selected) return null;
  const timestamp = (value: number | null) =>
    value === null ? "—" : new Date(value).toLocaleString(i18n.language);
  return (
    <aside
      className="flex min-h-0 w-[min(100%,24rem)] shrink-0 flex-col gap-3 overflow-hidden border-l border-line p-4"
      aria-label={t("monitor.processes.details")}
      data-testid="process-detail"
    >
      <div className="flex shrink-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="break-all text-base font-semibold">{detail?.name ?? selected.name}</h2>
          <p className="text-xs text-fg-muted">
            {t("monitor.processes.pid")}: {selected.pid}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("common.close")}
          onClick={() => inspector.select(null)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <ResourceError error={inspector.inspection.error} />
        <ResourceError error={inspector.targetError} />
        <ResourceError error={inspector.error} />
        {inspector.notice ? (
          <p role="status" className="text-xs text-fg-muted">
            {inspector.notice}
          </p>
        ) : null}
        {!detail && !inspector.inspection.error ? <LoadingBlock /> : null}
        {detail ? (
          <>
            <SimulatedBadge source={detail.source} />
            <DefinitionRows
              rows={[
                [
                  t("monitor.processes.state"),
                  t(`monitor.processes.states.${detail.state[0]}`, { defaultValue: detail.state }),
                ],
                [t("monitor.processes.user"), detail.user ?? "—"],
                [t("monitor.processes.parentPid"), detail.parentPid ?? "—"],
                [
                  t("monitor.processes.cpu"),
                  `${formatNumber(detail.cpuPercent, i18n.language, 1)}%`,
                ],
                [t("monitor.processes.memory"), formatBytes(detail.memoryBytes, i18n.language)],
                [
                  t("monitor.processes.virtualMemory"),
                  detail.virtualMemoryBytes === null
                    ? "—"
                    : formatBytes(detail.virtualMemoryBytes, i18n.language),
                ],
                [t("monitor.processes.threads"), detail.threads ?? "—"],
                [t("monitor.processes.startedAt"), timestamp(detail.startedAt)],
                [t("monitor.processes.sampledAt"), timestamp(detail.sampledAt)],
                [t("monitor.processes.service"), detail.serviceUnit ?? "—"],
                [
                  t("monitor.processes.container"),
                  target?.kind === "container" ? target.name : (detail.containerId ?? "—"),
                ],
                ...(permissions.includes("system:manage")
                  ? ([
                      [t("monitor.processes.executable"), detail.executable ?? "—"],
                      [t("monitor.processes.workingDirectory"), detail.workingDirectory ?? "—"],
                      [t("monitor.processes.command"), detail.command],
                    ] as Array<[string, string]>)
                  : []),
              ]}
            />
            <div className="flex flex-wrap gap-2">
              {inspector.actions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === "stop" ? "danger" : "secondary"}
                  disabled={!inspector.available}
                  loading={inspector.pending === action}
                  onClick={() => void inspector.act(action)}
                >
                  {t(`monitor.processes.actions.${action}`)}
                </Button>
              ))}
            </div>
            <SimulatedBadge source={target?.source} />
            <p className="text-xs text-fg-muted">
              {t(
                target?.protected
                  ? "monitor.processes.protected"
                  : target && permissions.includes(target.permission)
                    ? "monitor.processes.supervisorHint"
                    : detail.serviceUnit || detail.containerId
                      ? "monitor.processes.managementUnavailable"
                      : "monitor.processes.unmanaged",
              )}
            </p>
            {permissions.includes("terminal:access") && permissions.includes("apps:manage") ? (
              <ProcessExplanation key={`${detail.pid}:${detail.startedAt}`} detail={detail} />
            ) : (
              <p className="text-xs text-fg-muted">{t("monitor.processes.aiPermission")}</p>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}
