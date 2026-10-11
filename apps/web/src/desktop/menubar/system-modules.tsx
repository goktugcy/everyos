import type { NetworkStatus, TailscaleStatus } from "@everyos/shared";
import { Activity, Globe, Network, WifiOff } from "lucide-react";
import { Popover } from "radix-ui";
import { useTranslation } from "react-i18next";
import { useLiveMetrics, useLiveMetricsSubscription } from "../../features/metrics/live-metrics.ts";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { formatBytes, formatCelsius, formatNumber, formatPercent } from "../../lib/format.ts";
import { InternetBadge, TailscaleCard } from "../apps/system/network-tab.tsx";
import { DefinitionRows } from "../apps/system/parts.tsx";
import { desktop } from "../state/controller.ts";
import { menubarButton } from "./menubar-button.ts";
export { PowerModule } from "./power-module.tsx";

const popoverClass =
  "glass-strong everyos-enter z-[8000] flex w-80 flex-col gap-3 rounded-everyos-lg p-4 text-sm text-fg";

/** Live CPU / memory readout in the menu bar (requires system:read). */
export function ResourcesModule() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  useLiveMetricsSubscription();
  const snapshot = useLiveMetrics((state) => state.snapshot);
  const point = snapshot?.point;
  const cpu = point?.cpuPercent ?? null;
  const memory =
    typeof point?.memoryUsedBytes === "number" && point.memoryTotalBytes
      ? (point.memoryUsedBytes / point.memoryTotalBytes) * 100
      : null;
  const summary =
    cpu !== null && memory !== null
      ? t("menubar.resourcesSummary", {
          cpu: formatNumber(cpu, language),
          memory: formatNumber(memory, language),
        })
      : t("menubar.resources");

  return (
    <Popover.Root>
      <Popover.Trigger
        className={menubarButton}
        aria-label={`${t("menubar.resources")}: ${summary}`}
        data-testid="menubar-resources"
      >
        <Activity className="size-4" aria-hidden />
        <span className="hidden tabular-nums md:inline">
          {cpu !== null ? formatPercent(cpu, language) : "—"}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={8} className={popoverClass}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("menubar.resources")}
          </h3>
          <DefinitionRows
            rows={[
              [t("monitor.cpu"), cpu !== null ? formatPercent(cpu, language, 1) : "—"],
              [
                t("monitor.memory"),
                typeof point?.memoryUsedBytes === "number" &&
                typeof point.memoryTotalBytes === "number"
                  ? t("monitor.usedOf", {
                      used: formatBytes(point.memoryUsedBytes, language),
                      total: formatBytes(point.memoryTotalBytes, language),
                    })
                  : "—",
              ],
              [
                t("monitor.load"),
                snapshot?.load ? formatNumber(snapshot.load[0], language, 2) : "—",
              ],
              [
                t("monitor.temperature"),
                typeof point?.temperatureC === "number"
                  ? formatCelsius(point.temperatureC, language)
                  : "—",
              ],
              [
                t("monitor.netTraffic"),
                typeof point?.netRxBytesPerSec === "number" &&
                typeof point.netTxBytesPerSec === "number"
                  ? t("monitor.net.live", {
                      rx: t("monitor.perSecond", {
                        value: formatBytes(point.netRxBytesPerSec, language),
                      }),
                      tx: t("monitor.perSecond", {
                        value: formatBytes(point.netTxBytesPerSec, language),
                      }),
                    })
                  : "—",
              ],
            ]}
          />
          <Popover.Close asChild>
            <button
              type="button"
              className="self-start text-sm font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => desktop.openApp("everyos.system", { appState: { tab: "overview" } })}
            >
              {t("menubar.openMonitor")}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Internet reachability and Tailscale state in the menu bar. */
export function NetworkModule() {
  const { t } = useTranslation();
  const network = useApiResource<NetworkStatus>("/system/network", 60_000);
  const tailscale = useApiResource<TailscaleStatus>("/system/tailscale", 60_000);
  const state = network.data?.internet.state;
  const Icon = state === "offline" ? WifiOff : state === "online" ? Globe : Network;
  const label = state
    ? `${t("menubar.network")}: ${t(`monitor.net.internetStates.${state}`)}`
    : t("menubar.network");

  return (
    <Popover.Root>
      <Popover.Trigger
        className={menubarButton}
        aria-label={label}
        title={label}
        data-testid="menubar-network"
      >
        <Icon className={state === "offline" ? "size-4 text-danger" : "size-4"} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={8} className={popoverClass}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("menubar.network")}
          </h3>
          {network.data ? (
            <>
              <InternetBadge internet={network.data.internet} />
              <DefinitionRows
                rows={network.data.interfaces
                  .filter(
                    (nic) =>
                      nic.up &&
                      !["loopback", "bridge", "virtual"].includes(nic.kind) &&
                      nic.addresses.length > 0,
                  )
                  .slice(0, 4)
                  .map((nic) => [
                    nic.name,
                    <span key={nic.name} className="font-mono text-xs">
                      {nic.addresses.map((a) => a.address).join(", ")}
                    </span>,
                  ])}
              />
            </>
          ) : null}
          {tailscale.data ? (
            <section className="flex flex-col gap-2 border-t border-line pt-3">
              <h4 className="text-xs font-semibold text-fg-muted">
                {t("monitor.tailscale.title")}
              </h4>
              <TailscaleCard status={tailscale.data} />
              {tailscale.data.status.available ? (
                <Popover.Close asChild>
                  <button
                    type="button"
                    className="self-start text-sm font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => desktop.openApp("everyos.tailscale")}
                  >
                    {t("menubar.openTailscale")}
                  </button>
                </Popover.Close>
              ) : null}
            </section>
          ) : null}
          <Popover.Close asChild>
            <button
              type="button"
              className="self-start text-sm font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => desktop.openApp("everyos.system", { appState: { tab: "network" } })}
            >
              {t("menubar.openNetwork")}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
