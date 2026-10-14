import type { AiAgentDiscovery, AiAgentKind } from "@everyos/shared";
import { Download, ScanSearch } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { useAiAgents } from "./agent-store.ts";

interface Discovery {
  discoveries: AiAgentDiscovery[];
  source: "host" | "simulated";
  nativeError: string | null;
  dockerError: string | null;
}
export function AgentDiscovery({
  onImported,
  onConnect,
}: {
  onImported: (kind: AiAgentKind) => void;
  onConnect: (candidate: AiAgentDiscovery) => void;
}) {
  const { t } = useTranslation();
  const scan = useApiResource<Discovery>("/ai-agents/discover", 60_000);
  const [selected, setSelected] = useState<AiAgentDiscovery | null>(null),
    [includeSettings, setIncludeSettings] = useState(true),
    [includeHistory, setIncludeHistory] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    missingGatewayKey: boolean;
  } | null>(null);
  const refresh = useAiAgents((state) => state.refresh);
  const importing = async () => {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      const result = await api<{ imported: number; skipped: number; missingGatewayKey: boolean }>(
        `/ai-agents/${selected.kind}/import`,
        {
          method: "POST",
          body: {
            id: selected.id,
            fingerprint: selected.fingerprint,
            includeSettings,
            includeHistory,
            confirm: selected.kind,
          },
        },
      );
      setResult(result);
      setSelected(null);
      await refresh();
      onImported(selected.kind);
      scan.reload();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-everyos-lg border border-line p-4"
      data-testid="ai-agent-discovery"
    >
      <div className="flex items-center gap-2">
        <ScanSearch className="size-5 text-accent" aria-hidden />
        <h3 className="text-sm font-semibold">{t("aiAgents.discoveryTitle")}</h3>
        <SimulatedBadge source={scan.data?.source} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          loading={scan.loading || scan.refreshing}
          onClick={scan.reload}
        >
          {t("aiAgents.scan")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-fg-muted">{t("aiAgents.discoveryHint")}</p>
      <ResourceError error={scan.error ?? error} onDismiss={() => setError(null)} />
      {scan.data?.nativeError || scan.data?.dockerError ? (
        <p className="text-xs text-warning">{t("aiAgents.discoveryLimited")}</p>
      ) : null}
      {scan.data && !scan.data.discoveries.length ? (
        <p className="text-xs text-fg-subtle">
          {t(
            scan.data.nativeError || scan.data.dockerError
              ? "aiAgents.discoveryUnavailable"
              : "aiAgents.noDiscovered",
          )}
        </p>
      ) : null}
      {scan.data?.discoveries.map((candidate) => (
        <div
          key={candidate.id}
          className="glass-inset flex flex-wrap items-center gap-3 rounded-everyos-md p-3"
        >
          <AiAgentIcon kind={candidate.kind} className="size-6 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t(`aiAgents.names.${candidate.kind}`)} · {candidate.name}
            </p>
            <p className="mt-1 break-all text-xs text-fg-subtle">
              {t(
                candidate.source === "native"
                  ? "aiAgents.nativeSource"
                  : "aiAgents.containerSource",
              )}{" "}
              · {candidate.baseUrl}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {t("aiAgents.discoveredDetails", {
                key: t(candidate.hasGatewayKey ? "common.yes" : "common.no"),
                count: candidate.historyCount,
              })}
            </p>
            {candidate.historyWarning ? (
              <p className="mt-1 text-xs text-warning">
                {t(`aiAgents.historyWarnings.${candidate.historyWarning}`)}
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (!candidate.canImport) {
                onConnect(candidate);
                return;
              }
              setSelected(candidate);
              setIncludeSettings(true);
              setIncludeHistory(candidate.historyCount > 0);
            }}
          >
            <Download className="size-4" aria-hidden />
            {t(candidate.canImport ? "aiAgents.import" : "aiAgents.useConnection")}
          </Button>
        </div>
      ))}
      {result ? (
        <Alert
          tone={result.missingGatewayKey ? "warning" : "success"}
          onDismiss={() => setResult(null)}
        >
          {t("aiAgents.imported", result)}
          {result.missingGatewayKey ? (
            <p className="mt-1">{t("aiAgents.importMissingKey")}</p>
          ) : null}
        </Alert>
      ) : null}
      {selected ? (
        <Dialog
          open
          onOpenChange={(open) => !open && !pending && setSelected(null)}
          title={t("aiAgents.importTitle", { agent: t(`aiAgents.names.${selected.kind}`) })}
        >
          <p className="text-sm leading-relaxed text-fg-muted">{t("aiAgents.importConfirm")}</p>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeSettings}
              disabled={pending}
              onChange={(event) => setIncludeSettings(event.target.checked)}
            />
            {t("aiAgents.importSettings")}
          </label>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeHistory}
              disabled={pending || selected.historyCount === 0}
              onChange={(event) => setIncludeHistory(event.target.checked)}
            />
            {t("aiAgents.importHistory", { count: selected.historyCount })}
          </label>
          <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
            {t("aiAgents.importLimits")}
          </p>
          <ResourceError error={error} />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" disabled={pending} onClick={() => setSelected(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={pending}
              disabled={!includeSettings && !includeHistory}
              onClick={() => void importing()}
            >
              {t("aiAgents.import")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
