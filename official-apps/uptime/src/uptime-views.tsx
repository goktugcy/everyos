import type { NetMonitorCheck } from "@everyos/app-sdk";
import { Badge, Button, DataTable, useI18n, useT } from "@everyos/app-ui";
import { useState } from "react";
import { incidentTimeline, type Health } from "./uptime.ts";

export const TONES = {
  up: "success",
  down: "danger",
  degraded: "warning",
  unknown: "neutral",
  pending: "neutral",
  blocked: "warning",
  paused: "neutral",
} as const;
export function HealthBadge({ state }: { state: Health }) {
  const t = useT();
  return <Badge tone={TONES[state]}>{t(`health.${state}`)}</Badge>;
}
const REASONS = new Set([
  "status",
  "keyword",
  "blocked",
  "dns",
  "refused",
  "unreachable",
  "timeout",
  "reset",
  "tls",
  "too-many-redirects",
  "invalid-response",
  "error",
]);
export function AvailabilityHistory({ checks }: { checks: readonly NetMonitorCheck[] }) {
  const t = useT();
  const i18n = useI18n();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(checks.length / 100));
  const current = Math.min(page, pages - 1);
  const date = (at: number) => i18n.date(at, { dateStyle: "medium", timeStyle: "medium" });
  const result = (check: NetMonitorCheck) =>
    check.ok
      ? t("history.ok")
      : t(`failure.${check.error && REASONS.has(check.error) ? check.error : "other"}`);
  const events = incidentTimeline(checks);
  return (
    <div className="uptime-history">
      <h3>{t("history.title")}</h3>
      <p className="uptime-hint">{t("history.limit", { count: checks.length })}</p>
      <div className="uptime-timeline" role="img" aria-label={t("history.timeline")}>
        {checks
          .slice(0, 60)
          .reverse()
          .map((check) => (
            <span
              key={check.at}
              data-ok={check.ok}
              title={`${date(check.at)} · ${result(check)}`}
            />
          ))}
      </div>
      {!checks.length ? <p>{t("history.empty")}</p> : null}
      <div className="uptime-table">
        <DataTable
          label={t("history.title")}
          rows={checks.slice(current * 100, (current + 1) * 100)}
          getKey={(check) => String(check.at)}
          columns={[
            { key: "at", label: t("history.at"), render: (check) => date(check.at) },
            {
              key: "ok",
              label: t("history.result"),
              render: (check) => (
                <Badge tone={check.ok ? "success" : "danger"}>{result(check)}</Badge>
              ),
            },
            {
              key: "status",
              label: t("monitor.status"),
              render: (check) =>
                check.status === null
                  ? t("monitor.noData")
                  : i18n.number(check.status, { useGrouping: false }),
            },
            {
              key: "ms",
              label: t("monitor.latency"),
              render: (check) =>
                check.ms === null
                  ? t("monitor.noData")
                  : t("monitor.ms", { value: i18n.number(check.ms) }),
            },
          ]}
        />
      </div>
      <div className="uptime-actions">
        <Button disabled={!current} onClick={() => setPage(current - 1)}>
          {t("history.previous")}
        </Button>
        <span>{t("history.page", { page: current + 1, pages })}</span>
        <Button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
          {t("history.next")}
        </Button>
      </div>
      <h3>{t("incidents.title")}</h3>
      <p className="uptime-hint">{t("incidents.hint")}</p>
      {events.length ? (
        <ol className="uptime-incidents">
          {events.map((event) => (
            <li key={event.at}>
              <time dateTime={new Date(event.at).toISOString()}>{date(event.at)}</time>
              <strong>{t(`incidents.${event.kind}`)}</strong>
              <span>{result(event.check)}</span>
              {event.partialStart ? <span>{t("incidents.partial")}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p>{t("incidents.empty")}</p>
      )}
    </div>
  );
}
