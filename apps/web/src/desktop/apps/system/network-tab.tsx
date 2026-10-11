import type { NetworkInterfaceKind, NetworkStatus, TailscaleStatus } from "@everyos/shared";
import { CircleCheck, CircleSlash, Globe, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLiveMetrics } from "../../../features/metrics/live-metrics.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { cn } from "../../../lib/cn.ts";
import { formatBytes } from "../../../lib/format.ts";
import {
  DefinitionRows,
  LoadingBlock,
  ResourceError,
  SectionTitle,
  SimulatedBadge,
} from "./parts.tsx";

export function InternetBadge({ internet }: { internet: NetworkStatus["internet"] }) {
  const { t } = useTranslation();
  const online = internet.state === "online";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        online
          ? "bg-success/15 text-success"
          : internet.state === "offline"
            ? "bg-danger/15 text-danger"
            : "bg-hover/8 text-fg-muted",
      )}
    >
      {online ? (
        <Globe className="size-3.5" aria-hidden />
      ) : (
        <WifiOff className="size-3.5" aria-hidden />
      )}
      {t(`monitor.net.internetStates.${internet.state}`)}
      {online && internet.latencyMs !== null
        ? ` · ${t("monitor.net.latency", { ms: internet.latencyMs })}`
        : null}
    </span>
  );
}

export function TailscaleCard({ status }: { status: TailscaleStatus }) {
  const { t } = useTranslation();
  if (!status.status.available) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-muted">
        <CircleSlash className="size-4" aria-hidden />
        {t(`system.reasons.${status.status.reason ?? "not-detected"}`)}
      </p>
    );
  }
  return (
    <DefinitionRows
      rows={[
        [
          t("monitor.tailscale.state"),
          <span key="state" className="inline-flex items-center gap-1.5">
            {status.online ? (
              <CircleCheck className="size-4 text-success" aria-hidden />
            ) : (
              <CircleSlash className="size-4 text-fg-subtle" aria-hidden />
            )}
            {status.online ? t("monitor.tailscale.online") : t("monitor.tailscale.offline")}
            {status.backendState ? (
              <span className="text-fg-subtle">({status.backendState})</span>
            ) : null}
          </span>,
        ],
        [t("monitor.tailscale.hostName"), status.hostName ?? "—"],
        [t("monitor.tailscale.dnsName"), status.dnsName ?? "—"],
        [t("monitor.tailscale.tailnet"), status.tailnet ?? "—"],
        [
          t("monitor.tailscale.ips"),
          <span key="ips" className="font-mono text-xs">
            {status.ips.join(", ") || "—"}
          </span>,
        ],
        [
          t("monitor.tailscale.exitNode"),
          status.exitNode.active
            ? (status.exitNode.name ?? "✓")
            : t("monitor.tailscale.exitNodeNone"),
        ],
        [
          t("monitor.tailscale.peers"),
          t("monitor.tailscale.peersValue", {
            online: status.peers.online,
            total: status.peers.total,
          }),
        ],
        [t("monitor.tailscale.version"), status.version ?? "—"],
        ...(status.health.length > 0
          ? ([
              [
                t("monitor.tailscale.health"),
                <ul key="health" className="list-disc pl-4">
                  {status.health.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>,
              ],
            ] as Array<[string, ReactNode]>)
          : []),
      ]}
    />
  );
}

const SECONDARY_KINDS: ReadonlySet<NetworkInterfaceKind> = new Set([
  "loopback",
  "bridge",
  "virtual",
]);

type InterfaceInfo = NetworkStatus["interfaces"][number];
type InterfaceRate = { rxBytesPerSec: number; txBytesPerSec: number };

function InterfaceCard({ nic, rate }: { nic: InterfaceInfo; rate: InterfaceRate | undefined }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  return (
    <li className="glass-inset flex flex-col gap-1.5 rounded-everyos-md p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-semibold">{nic.name}</span>
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span
            className={cn("size-2 rounded-full", nic.up ? "bg-success" : "bg-fg-subtle")}
            aria-hidden
          />
          {nic.up ? t("monitor.net.up") : t("monitor.net.down")} ·{" "}
          {t(`monitor.net.kinds.${nic.kind}`)}
        </span>
      </div>
      <div className="font-mono text-xs text-fg-muted">
        {nic.addresses.length > 0
          ? nic.addresses.map((a) => `${a.address}/${a.prefix}`).join(", ")
          : t("monitor.net.noAddress")}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-fg-subtle">
        {nic.mac ? (
          <span>
            {t("monitor.net.mac")} {nic.mac}
          </span>
        ) : null}
        {nic.mtu ? (
          <span>
            {t("monitor.net.mtu")} {nic.mtu}
          </span>
        ) : null}
        {nic.speedMbps ? (
          <span>{t("monitor.net.speedValue", { value: nic.speedMbps })}</span>
        ) : null}
      </div>
      {rate ? (
        <div className="text-xs font-medium tabular-nums text-fg">
          {t("monitor.net.live", {
            rx: t("monitor.perSecond", {
              value: formatBytes(rate.rxBytesPerSec, language),
            }),
            tx: t("monitor.perSecond", {
              value: formatBytes(rate.txBytesPerSec, language),
            }),
          })}
        </div>
      ) : null}
    </li>
  );
}

export function NetworkTab() {
  const { t } = useTranslation();
  const network = useApiResource<NetworkStatus>("/system/network", 30_000);
  const tailscale = useApiResource<TailscaleStatus>("/system/tailscale", 30_000);
  const rates = useLiveMetrics((state) => state.snapshot?.interfaces ?? null);
  const rateFor = (name: string) => rates?.find((entry) => entry.name === name);
  const interfaces = network.data?.interfaces ?? [];
  // Docker hosts have dozens of bridges and veth pairs; keep them out of the way.
  const primary = interfaces.filter((nic) => !SECONDARY_KINDS.has(nic.kind));
  const secondary = interfaces.filter((nic) => SECONDARY_KINDS.has(nic.kind));

  return (
    <div className="flex flex-col gap-5">
      <ResourceError error={network.error} />
      {network.loading ? <LoadingBlock /> : null}
      {network.data ? (
        <>
          <section className="flex flex-col gap-2">
            <SectionTitle aside={<SimulatedBadge source={network.data.source} />}>
              {t("monitor.net.internet")}
            </SectionTitle>
            <div className="flex flex-wrap items-center gap-3">
              <InternetBadge internet={network.data.internet} />
            </div>
            <DefinitionRows
              rows={[
                [
                  t("monitor.net.gateways"),
                  network.data.gateways.length > 0
                    ? network.data.gateways.map((g) => `${g.address} (${g.interface})`).join(", ")
                    : t("monitor.net.none"),
                ],
                [t("monitor.net.dns"), network.data.dns.join(", ") || t("monitor.net.none")],
              ]}
            />
          </section>
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("monitor.net.interfaces")}</SectionTitle>
            <ul className="grid gap-2 @2xl:grid-cols-2">
              {primary.map((nic) => (
                <InterfaceCard key={nic.name} nic={nic} rate={rateFor(nic.name)} />
              ))}
            </ul>
            {secondary.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer select-none rounded-everyos-sm py-1 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent">
                  {t("monitor.net.virtualInterfaces", { count: secondary.length })}
                </summary>
                <ul className="mt-2 grid gap-2 @2xl:grid-cols-2">
                  {secondary.map((nic) => (
                    <InterfaceCard key={nic.name} nic={nic} rate={rateFor(nic.name)} />
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        </>
      ) : null}
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("monitor.tailscale.title")}</SectionTitle>
        <ResourceError error={tailscale.error} />
        {tailscale.data ? (
          <TailscaleCard status={tailscale.data} />
        ) : tailscale.loading ? (
          <LoadingBlock />
        ) : null}
      </section>
    </div>
  );
}
