import type { IntegrationData, IntegrationInfo } from "@everyos/app-sdk";
import { useEffect, useState } from "react";
import { app, i18n, useLanguage } from "./everyos.ts";

/** What EveryOS's Uptime Kuma integration reports (its `monitors` feed). */
interface KumaMonitors {
  up: number;
  down: number;
  pending: number;
  maintenance: number;
  monitors: Array<{ name: string; type: string | null; status: string; responseMs: number | null }>;
}

/**
 * A hybrid app: the backend is Uptime Kuma (installed from the Docker App Store, or running
 * elsewhere), connected by an administrator as an EveryOS integration. The app reads the
 * integration's data through EveryOS and never sees its address or API key.
 */
export function Monitors() {
  useLanguage();
  const [integrations, setIntegrations] = useState<IntegrationInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<IntegrationData | null>(null);
  useEffect(() => {
    void app.host.call("integration.list").then(({ integrations: list }) => {
      setIntegrations(list);
      setSelected(list[0]?.id ?? null);
    });
  }, []);
  useEffect(() => {
    if (!selected) return;
    const load = () =>
      void app.host
        .call("integration.data", { integration: selected, feed: "monitors" })
        .then(setData);
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [selected]);

  if (integrations === null) return <main aria-busy="true" />;
  if (!integrations.length)
    return (
      <main>
        <h1>{i18n.t("monitors.title")}</h1>
        <p className="status">{i18n.t("monitors.none")}</p>
      </main>
    );
  const report = data?.status === "ok" ? (data.data as KumaMonitors) : null;
  return (
    <main>
      <h1>{i18n.t("monitors.title")}</h1>
      {integrations.length > 1 ? (
        <select
          aria-label={i18n.t("monitors.source")}
          value={selected ?? ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          {integrations.map((integration) => (
            <option key={integration.id} value={integration.id}>
              {integration.name}
            </option>
          ))}
        </select>
      ) : null}
      {data && data.status !== "ok" ? (
        <p className="status" role="alert">
          {i18n.t("monitors.unavailable")}
        </p>
      ) : null}
      {report ? (
        <>
          <p className="status" role="status">
            {i18n.t("monitors.summary", { up: report.up, down: report.down })}
          </p>
          <ul className="monitors">
            {report.monitors.map((monitor) => (
              <li key={monitor.name} data-status={monitor.status}>
                <span>{monitor.name}</span>
                <span>
                  {i18n.t(`monitors.states.${monitor.status}`)}
                  {monitor.responseMs !== null ? ` · ${i18n.number(monitor.responseMs)} ms` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
