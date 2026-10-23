import { Badge, LoadingState, errorMessage, useApp, useI18n, useT } from "@everyos/app-ui";
import { useId } from "react";
import { durationParts, healthSummary } from "./uptime.ts";
import { HealthBadge } from "./uptime-views.tsx";
import { useUptimeData } from "./use-uptime-data.ts";

export function HealthWidget() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const descriptionId = useId();
  const data = useUptimeData();
  const info = data.info?.value ?? null;
  const services = data.services?.value ?? null;
  const error = data.infoError || data.servicesError || data.monitorsError;
  const health = healthSummary(info, services, data.monitors?.value ?? null, !!error, Date.now());
  const simulated = info?.source === "simulated" || services?.source === "simulated";
  return (
    <div className="uptime-widget">
      {data.loading && !info && !data.monitors ? (
        <LoadingState />
      ) : (
        <>
          <button
            type="button"
            className="uptime-widget-open"
            aria-label={t("widget.open")}
            aria-describedby={descriptionId}
            onClick={() => void app.window.open(null)}
          >
            <span id={descriptionId} className="uptime-widget-data">
              <span className="uptime-widget-meta">
                <HealthBadge state={health.state} />
                {simulated ? (
                  <span role="status">
                    <Badge tone="warning">{t("source.simulated")}</Badge>
                  </span>
                ) : health.limited && health.state !== "unknown" ? (
                  <Badge tone="warning">{t("widget.limited")}</Badge>
                ) : null}
              </span>
              <strong>
                {info ? t("duration.full", durationParts(info.uptimeSeconds)) : t("monitor.noData")}
              </strong>
              <span>
                {t("widget.endpoints", { up: health.counts.up, total: health.endpoints })}
              </span>
              {info ? (
                <span className="uptime-hint uptime-widget-time">
                  {t("host.measured", { at: i18n.date(info.collectedAt, { timeStyle: "short" }) })}
                </span>
              ) : null}
            </span>
          </button>
          {error ? <span role="alert">{errorMessage(t, error)}</span> : null}
        </>
      )}
    </div>
  );
}
