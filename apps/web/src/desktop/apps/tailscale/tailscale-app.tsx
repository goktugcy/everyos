import type {
  TailscaleOverview,
  TailscalePeer,
  TailscalePeers,
  TailscaleWarning,
} from "@otuken/shared";
import { CircleSlash, ExternalLink, Globe, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { formatBytes, formatDateTime, formatRelative } from "../../../lib/format.ts";
import { TailscaleCard } from "../system/network-tab.tsx";
import { DefinitionRows, LoadingBlock, ResourceError, SectionTitle } from "../system/parts.tsx";

const TONE = { info: "info", warning: "warning", critical: "danger" } as const;

function Warning({ warning }: { warning: TailscaleWarning }) {
  const { t, i18n } = useTranslation();
  const params = { ...warning.params };
  if (typeof params.at === "number") params.at = formatDateTime(params.at, i18n.language);
  return (
    <Alert tone={TONE[warning.severity]}>
      <span data-testid="tailscale-warning">{t(`tailscale.warnings.${warning.kind}`, params)}</span>
    </Alert>
  );
}

const yesNo =
  (t: (key: "tailscale.yes" | "tailscale.no" | "tailscale.unknown") => string) =>
  (value: boolean | null) =>
    value === null ? t("tailscale.unknown") : value ? t("tailscale.yes") : t("tailscale.no");

function Peers() {
  const { t, i18n } = useTranslation();
  const peers = useApiResource<TailscalePeers>("/system/tailscale/peers", 30_000);
  const connection = (peer: TailscalePeer) =>
    peer.connection === "relay"
      ? t("tailscale.connection.relay", { relay: peer.relay ?? "?" })
      : t(`tailscale.connection.${peer.connection}`);
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{t("tailscale.devices")}</SectionTitle>
      <ResourceError error={peers.error} />
      {peers.data?.peers.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("tailscale.noDevices")}</p>
      ) : null}
      {peers.data && peers.data.peers.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="tailscale-peers">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th scope="col" className="py-1.5 pr-2 font-semibold">
                  {t("tailscale.columns.device")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tailscale.columns.address")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tailscale.columns.state")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tailscale.columns.path")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("tailscale.columns.traffic")}
                </th>
              </tr>
            </thead>
            <tbody>
              {peers.data.peers.map((peer, index) => (
                <tr
                  key={`${peer.dnsName ?? peer.hostName ?? ""}-${index}`}
                  className="border-t border-line"
                >
                  <td className="py-1.5 pr-2">
                    <div className="flex flex-col">
                      <span className="font-medium">{peer.hostName ?? peer.dnsName ?? "—"}</span>
                      <span className="text-xs text-fg-muted">
                        {[
                          peer.os,
                          peer.exitNode ? t("tailscale.usingExitNode") : null,
                          peer.exitNodeOption && !peer.exitNode
                            ? t("tailscale.offersExitNode")
                            : null,
                          ...peer.tags,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs">{peer.ips[0] ?? "—"}</td>
                  <td className="px-2 py-1.5 text-xs">
                    {peer.online ? (
                      <span className="text-success">{t("monitor.tailscale.online")}</span>
                    ) : (
                      <span className="text-fg-muted">
                        {t("monitor.tailscale.offline")}
                        {peer.lastSeen ? ` · ${formatRelative(peer.lastSeen, i18n.language)}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{connection(peer)}</td>
                  <td className="px-2 py-1.5 text-xs text-fg-muted">
                    ↓ {formatBytes(peer.rxBytes, i18n.language)} · ↑{" "}
                    {formatBytes(peer.txBytes, i18n.language)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** Tailscale in detail: this node, remote access to Otuken, warnings and the tailnet's devices. */
export default function TailscaleApp() {
  const { t, i18n } = useTranslation();
  const overview = useApiResource<TailscaleOverview>("/system/tailscale/overview", 30_000);
  const data = overview.data;
  const answer = yesNo(t);

  if (!data)
    return (
      <div className="p-4">
        <ResourceError error={overview.error} />
        {overview.loading ? <LoadingBlock /> : null}
      </div>
    );

  if (!data.status.status.available)
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="tailscale-unavailable"
      >
        <CircleSlash className="size-10 text-fg-subtle" aria-hidden />
        <h2 className="text-lg font-semibold">{t("tailscale.unavailableTitle")}</h2>
        <p className="max-w-md text-sm text-fg-muted">
          {t(`system.reasons.${data.status.status.reason ?? "not-detected"}`)}.{" "}
          {t("tailscale.unavailableHint")}
        </p>
      </div>
    );

  const { details, remoteAccess } = data;
  const rows: Array<[string, ReactNode]> = [
    [t("tailscale.self.os"), details.self.os ?? "—"],
    [t("tailscale.self.relay"), details.self.relay ?? "—"],
    [
      t("tailscale.self.keyExpiry"),
      details.self.keyExpired
        ? t("tailscale.self.keyExpired")
        : details.self.keyExpiry
          ? `${formatDateTime(details.self.keyExpiry, i18n.language)} (${formatRelative(details.self.keyExpiry, i18n.language)})`
          : t("tailscale.self.keyNoExpiry"),
    ],
    [t("tailscale.self.exitNode"), answer(details.self.exitNodeOption)],
    [t("tailscale.self.routes"), details.self.routes.join(", ") || "—"],
    [t("tailscale.self.magicDNS"), answer(details.self.magicDNS)],
    ...(details.self.tags.length
      ? ([[t("tailscale.self.tags"), details.self.tags.join(", ")]] as Array<[string, ReactNode]>)
      : []),
    ...(details.prefs.available
      ? ([
          [t("tailscale.prefs.ssh"), answer(details.prefs.ssh)],
          [t("tailscale.prefs.shieldsUp"), answer(details.prefs.shieldsUp)],
          [t("tailscale.prefs.acceptRoutes"), answer(details.prefs.acceptRoutes)],
          [t("tailscale.prefs.acceptDNS"), answer(details.prefs.acceptDNS)],
          [t("tailscale.prefs.advertisedRoutes"), details.prefs.advertisedRoutes.join(", ") || "—"],
          [t("tailscale.prefs.advertisesExitNode"), answer(details.prefs.advertisesExitNode)],
        ] as Array<[string, ReactNode]>)
      : ([[t("tailscale.prefs.title"), t("tailscale.prefs.unavailable")]] as Array<
          [string, ReactNode]
        >)),
  ];

  return (
    <div className="h-full overflow-auto" data-testid="tailscale-app">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
        {data.warnings.length > 0 ? (
          <section className="flex flex-col gap-2">
            {data.warnings.map((warning, index) => (
              <Warning key={`${warning.kind}-${index}`} warning={warning} />
            ))}
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <SectionTitle>{t("tailscale.connectionTitle")}</SectionTitle>
          <TailscaleCard status={data.status} />
        </section>

        <section className="flex flex-col gap-2" data-testid="tailscale-remote">
          <SectionTitle>{t("tailscale.remoteTitle")}</SectionTitle>
          {remoteAccess.urls.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {remoteAccess.urls.map((entry) => (
                <li key={entry.url} className="flex flex-wrap items-center gap-2 text-sm">
                  {entry.funnel ? (
                    <Globe className="size-4 text-danger" aria-hidden />
                  ) : (
                    <Lock className="size-4 text-success" aria-hidden />
                  )}
                  <a
                    className="font-mono text-accent hover:underline"
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {entry.url}
                    <ExternalLink className="ml-1 inline size-3.5" aria-hidden />
                  </a>
                  <span className={entry.funnel ? "text-xs text-danger" : "text-xs text-fg-muted"}>
                    {entry.funnel ? t("tailscale.public") : t("tailscale.tailnetOnly")}
                  </span>
                  <span className="text-xs text-fg-muted">
                    · {entry.originAllowed ? t("tailscale.originOk") : t("tailscale.originMissing")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">{t("tailscale.notPublished")}</p>
          )}
          {remoteAccess.suggestion ? (
            <div className="flex flex-col gap-2 rounded-otk-md border border-line p-3 text-sm">
              <p>{t("tailscale.suggestion", { url: remoteAccess.suggestion.url })}</p>
              <code className="block overflow-x-auto rounded-otk-sm bg-hover/8 px-2 py-1.5 font-mono text-xs">
                {remoteAccess.suggestion.command}
              </code>
              <p className="text-xs text-fg-muted">
                {t("tailscale.suggestionConfig", { url: remoteAccess.suggestion.url })}
              </p>
            </div>
          ) : null}
          <p className="text-xs text-fg-muted">{t("tailscale.readOnly")}</p>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>{t("tailscale.selfTitle")}</SectionTitle>
          <DefinitionRows rows={rows} />
        </section>

        {details.serve.available && details.serve.handlers.length > 0 ? (
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("tailscale.serveTitle")}</SectionTitle>
            <ul className="flex flex-col gap-1 font-mono text-xs" data-testid="tailscale-serve">
              {details.serve.handlers.map((handler, index) => (
                <li key={index}>
                  {handler.host || "*"}:{handler.port}
                  {handler.path} → {handler.target ?? t(`tailscale.serveKinds.${handler.kind}`)}
                  {handler.funnel ? (
                    <span className="ml-2 font-sans text-danger">{t("tailscale.funnel")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data.canSeePeers ? <Peers /> : null}
      </div>
    </div>
  );
}
