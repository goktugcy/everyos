import { CAPABILITY_IDS, type SystemInfo } from "@everyos/shared";
import {
  CheckCircle2,
  CircleSlash,
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  Timer,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { ApiRequestError } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatBytes, formatDateTime, formatDuration } from "../../lib/format.ts";
import type { SystemInfoState } from "./use-system-info.ts";

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-everyos-sm bg-hover/6 text-fg-subtle [&>svg]:size-4">
        {icon}
      </span>
      <dt className="w-32 shrink-0 text-sm text-fg-muted">{label}</dt>
      <dd
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

function Capabilities({ info }: { info: SystemInfo }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-fg-muted">{t("system.capabilitiesTitle")}</h3>
      <ul className="flex flex-wrap gap-2">
        {CAPABILITY_IDS.map((id) => {
          const status = info.capabilities[id];
          return (
            <li
              key={id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                status.available
                  ? "border-success/35 bg-success/10 text-fg"
                  : "border-line bg-hover/4 text-fg-subtle",
              )}
              title={
                status.available
                  ? t("system.available")
                  : t(`system.reasons.${status.reason ?? "not-detected"}`)
              }
            >
              {status.available ? (
                <CheckCircle2 className="size-3.5 text-success" aria-hidden />
              ) : (
                <CircleSlash className="size-3.5" aria-hidden />
              )}
              <span>{t(`system.capabilities.${id}`)}</span>
              {status.simulated ? (
                <span className="text-warning">· {t("system.sourceSimulated")}</span>
              ) : null}
              {!status.available ? (
                <span className="sr-only">
                  : {t(`system.reasons.${status.reason ?? "not-detected"}`)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Host information (used inside the System app window). */
export function SystemInfoView({ state }: { state: SystemInfoState }) {
  const { t, i18n } = useTranslation();
  const { info, error, loading } = state;
  const agentDown =
    error instanceof ApiRequestError && ["AGENT_UNAVAILABLE", "AGENT_TIMEOUT"].includes(error.code);

  return (
    <section className="flex flex-col gap-5" aria-labelledby="system-card-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="system-card-title" className="text-lg font-semibold tracking-tight">
          {t("system.title")}
        </h2>
        {info ? (
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider",
              info.source === "host" ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
            )}
          >
            {info.source === "host" ? t("system.sourceHost") : t("system.sourceSimulated")}
          </span>
        ) : null}
      </div>

      {loading && !info ? (
        <div className="flex justify-center py-10">
          <Spinner className="size-6 text-fg-subtle" label={t("common.loading")} />
        </div>
      ) : null}

      {error ? (
        <Alert tone="warning" title={agentDown ? t("agent.unavailable") : undefined}>
          {agentDown ? t("agent.unavailableHelp") : errorMessage(t, error)}
        </Alert>
      ) : null}

      {info ? (
        <>
          {info.platform !== "linux" ? (
            <Alert tone="info">{t("system.nonLinuxNotice")}</Alert>
          ) : null}
          <dl className="divide-y divide-line">
            <Row icon={<Server />} label={t("system.hostname")} value={info.hostname} />
            <Row icon={<HardDrive />} label={t("system.os")} value={info.os.prettyName} />
            <Row
              icon={<HardDrive />}
              label={t("system.kernel")}
              value={`${info.kernel} · ${info.arch}`}
            />
            <Row
              icon={<Cpu />}
              label={t("system.cpu")}
              value={`${info.cpu.model} · ${t("system.cores")}: ${info.cpu.cores}`}
            />
            <Row
              icon={<MemoryStick />}
              label={t("system.memory")}
              value={formatBytes(info.memory.totalBytes, i18n.language)}
            />
            <Row
              icon={<Timer />}
              label={t("system.uptime")}
              value={formatDuration(info.uptimeSeconds, i18n.language)}
            />
            <Row
              icon={<Server />}
              label={t("system.hardware")}
              value={info.hardware.model ?? t("system.unknown")}
            />
          </dl>
          <Capabilities info={info} />
          <p className="text-xs text-fg-subtle">
            {t("system.refreshed", {
              time: formatDateTime(info.collectedAt, i18n.language, { timeStyle: "medium" }),
            })}
          </p>
        </>
      ) : null}
    </section>
  );
}
