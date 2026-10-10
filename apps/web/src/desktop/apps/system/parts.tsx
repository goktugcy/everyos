import { AlertTriangle, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { ApiRequestError } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatPercent } from "../../../lib/format.ts";

/** Labels data that did not come from the real host (development simulator). */
export function SimulatedBadge({ source }: { source: "host" | "simulated" | undefined }) {
  const { t } = useTranslation();
  if (source !== "simulated") return null;
  return (
    <span
      className="rounded-full bg-warning/15 px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider text-warning"
      data-testid="simulated-badge"
    >
      {t("system.sourceSimulated")}
    </span>
  );
}

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-0.5 rounded-otk-md px-3 py-2.5">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="truncate text-xl font-semibold text-fg">{value}</span>
      {detail ? <span className="truncate text-xs text-fg-subtle">{detail}</span> : null}
    </div>
  );
}

/**
 * Usage meter. Severity is carried by fill color plus an icon and the
 * percentage text, never by color alone.
 */
export function Meter({
  percent,
  label,
  warnAt = 80,
  dangerAt = 90,
}: {
  percent: number;
  label: string;
  warnAt?: number;
  dangerAt?: number;
}) {
  const { i18n } = useTranslation();
  const level = percent >= dangerAt ? "danger" : percent >= warnAt ? "warning" : "normal";
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-[rgb(var(--otk-accent)/0.16)]"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
      >
        <div
          className={cn(
            "h-full rounded-full",
            level === "danger" ? "bg-danger" : level === "warning" ? "bg-warning" : "bg-accent",
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="flex w-16 items-center justify-end gap-1 text-xs font-semibold tabular-nums text-fg">
        {level === "danger" ? <OctagonAlert className="size-3.5 text-danger" aria-hidden /> : null}
        {level === "warning" ? (
          <AlertTriangle className="size-3.5 text-warning" aria-hidden />
        ) : null}
        {formatPercent(clamped, i18n.language)}
      </span>
    </div>
  );
}

export function LoadingBlock() {
  const { t } = useTranslation();
  return (
    <div className="flex justify-center py-10">
      <Spinner className="size-6 text-fg-subtle" label={t("common.loading")} />
    </div>
  );
}

/** Explains why data is missing (agent down, host without the feature, …). */
export function ResourceError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const agentDown =
    error instanceof ApiRequestError && ["AGENT_UNAVAILABLE", "AGENT_TIMEOUT"].includes(error.code);
  return (
    <Alert tone="warning" title={agentDown ? t("agent.unavailable") : undefined}>
      {agentDown ? t("agent.unavailableHelp") : errorMessage(t, error)}
    </Alert>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-fg-muted">{children}</h3>
      {aside}
    </div>
  );
}

export function DefinitionRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="min-w-0 break-words text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
