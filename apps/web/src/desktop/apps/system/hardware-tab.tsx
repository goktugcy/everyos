import { THROTTLE_FLAGS, type HardwareStatus } from "@otuken/shared";
import { AlertTriangle, CheckCircle2, CircleSlash, OctagonAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLiveMetrics } from "../../../features/metrics/live-metrics.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { formatCelsius, formatNumber, formatPercent } from "../../../lib/format.ts";
import {
  DefinitionRows,
  LoadingBlock,
  Meter,
  ResourceError,
  SectionTitle,
  SimulatedBadge,
} from "./parts.tsx";

const CURRENT_FLAGS = THROTTLE_FLAGS.filter((flag) => !flag.endsWith("Occurred"));
const PAST_FLAGS = THROTTLE_FLAGS.filter((flag) => flag.endsWith("Occurred"));

function Unavailable({ reason }: { reason: string | undefined }) {
  const { t } = useTranslation();
  return (
    <p className="flex items-center gap-2 text-sm text-fg-muted">
      <CircleSlash className="size-4" aria-hidden />
      {t(`system.reasons.${(reason ?? "not-detected") as "not-detected"}`)}
    </p>
  );
}

function Throttling({ throttling }: { throttling: HardwareStatus["throttling"] }) {
  const { t } = useTranslation();
  if (!throttling.status.available || !throttling.flags)
    return <Unavailable reason={throttling.status.reason} />;
  const flags = throttling.flags;
  const group = (
    title: string,
    list: readonly (typeof THROTTLE_FLAGS)[number][],
    severe: boolean,
  ) => {
    const raised = list.filter((flag) => flags[flag]);
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-fg-muted">{title}</span>
        {raised.length === 0 ? (
          <span className="flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("monitor.hardware.allClear")}
          </span>
        ) : (
          <ul className="flex flex-col gap-1">
            {raised.map((flag) => (
              <li key={flag} className="flex items-center gap-1.5 text-sm">
                {severe ? (
                  <OctagonAlert className="size-4 text-danger" aria-hidden />
                ) : (
                  <AlertTriangle className="size-4 text-warning" aria-hidden />
                )}
                {t(`monitor.hardware.flags.${flag}`)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 @xl:grid-cols-2">
        {group(t("monitor.hardware.now"), CURRENT_FLAGS, true)}
        {group(t("monitor.hardware.sinceBoot"), PAST_FLAGS, false)}
      </div>
      {throttling.raw ? (
        <span className="font-mono text-xs text-fg-subtle">
          {t("monitor.hardware.raw", { value: throttling.raw })}
        </span>
      ) : null}
    </div>
  );
}

export function HardwareTab() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const snapshot = useLiveMetrics((state) => state.snapshot);
  const hardware = useApiResource<HardwareStatus>("/system/hardware", 60_000);

  return (
    <div className="flex flex-col gap-5">
      {snapshot?.cpuCores ? (
        <section className="flex flex-col gap-2">
          <SectionTitle aside={<SimulatedBadge source={snapshot.source} />}>
            {t("monitor.hardware.cores")}
          </SectionTitle>
          <ul className="grid gap-x-6 gap-y-1.5 @xl:grid-cols-2">
            {snapshot.cpuCores.map((value, index) => (
              <li
                key={index}
                className="grid grid-cols-[5rem_1fr] items-center gap-2 text-xs text-fg-muted"
              >
                <span>
                  {t("monitor.hardware.core", { n: index })}
                  {snapshot.cpuFrequencyMHz?.[index] !== undefined ? (
                    <span className="block text-[0.7rem] text-fg-subtle">
                      {formatNumber(snapshot.cpuFrequencyMHz[index], language)} MHz
                    </span>
                  ) : null}
                </span>
                <Meter
                  percent={value}
                  label={t("monitor.hardware.core", { n: index })}
                  warnAt={101}
                  dangerAt={101}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionTitle>{t("monitor.hardware.thermal")}</SectionTitle>
        {snapshot?.thermal && snapshot.thermal.length > 0 ? (
          <DefinitionRows
            rows={snapshot.thermal.map((zone) => [
              zone.type || zone.zone,
              formatCelsius(zone.celsius, language),
            ])}
          />
        ) : (
          <p className="text-sm text-fg-muted">{t("monitor.notMeasurable")}</p>
        )}
      </section>

      {snapshot?.fans && snapshot.fans.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>{t("monitor.hardware.fans")}</SectionTitle>
          <DefinitionRows
            rows={snapshot.fans.map((fan) => [
              fan.name,
              t("monitor.hardware.rpm", { rpm: formatNumber(fan.rpm, language) }),
            ])}
          />
        </section>
      ) : null}

      <ResourceError error={hardware.error} />
      {hardware.loading ? <LoadingBlock /> : null}
      {hardware.data ? (
        <>
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("monitor.hardware.throttling")}</SectionTitle>
            <Throttling throttling={hardware.data.throttling} />
          </section>
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("monitor.hardware.nvme")}</SectionTitle>
            {!hardware.data.nvme.status.available ? (
              <Unavailable reason={hardware.data.nvme.status.reason} />
            ) : (
              hardware.data.nvme.devices.map((device) => (
                <div
                  key={device.device}
                  className="glass-inset flex flex-col gap-2 rounded-otk-md p-3"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-mono font-semibold">{device.device}</span>
                    <span className="flex items-center gap-1.5 text-xs font-semibold">
                      {device.healthy === true ? (
                        <>
                          <CheckCircle2 className="size-4 text-success" aria-hidden />
                          {t("monitor.hardware.healthy")}
                        </>
                      ) : device.healthy === false ? (
                        <>
                          <OctagonAlert className="size-4 text-danger" aria-hidden />
                          {t("monitor.hardware.unhealthy")}
                        </>
                      ) : (
                        t("monitor.hardware.unknownHealth")
                      )}
                    </span>
                  </div>
                  <DefinitionRows
                    rows={[
                      [t("monitor.hardware.model"), device.model ?? "—"],
                      [
                        t("monitor.temperature"),
                        device.temperatureC !== null
                          ? formatCelsius(device.temperatureC, language)
                          : "—",
                      ],
                      [
                        t("monitor.hardware.wear"),
                        device.percentageUsed !== null
                          ? formatPercent(device.percentageUsed, language)
                          : "—",
                      ],
                      [
                        t("monitor.hardware.spare"),
                        device.availableSparePercent !== null
                          ? formatPercent(device.availableSparePercent, language)
                          : "—",
                      ],
                      [
                        t("monitor.hardware.powerOnHours"),
                        device.powerOnHours !== null
                          ? t("monitor.hardware.hours", {
                              value: formatNumber(device.powerOnHours, language),
                            })
                          : "—",
                      ],
                      [t("monitor.hardware.mediaErrors"), device.mediaErrors ?? "—"],
                    ]}
                  />
                </div>
              ))
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
