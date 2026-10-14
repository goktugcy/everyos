import { AI_AGENT_KINDS, type AiAgentDiscovery } from "@everyos/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { usePermissions } from "../../../stores/session-store.ts";
import { AgentSettings } from "../ai-agents/agent-settings.tsx";
import { useAiAgents } from "../ai-agents/agent-store.ts";
import { ResourceError } from "../system/parts.tsx";
import { useAppStateField } from "../app-context.ts";
import { AgentDiscovery } from "../ai-agents/agent-discovery.tsx";

export default function AgentsSection() {
  const { t } = useTranslation();
  const permissions = usePermissions(),
    [kind, setKind] = useAppStateField("agentKind", AI_AGENT_KINDS, "hermes");
  const { agents, error, loading, refresh } = useAiAgents();
  const [revision, setRevision] = useState(0),
    [connection, setConnection] = useState<AiAgentDiscovery | null>(null);
  const agent = agents.find((agent) => agent.kind === kind);
  if (!permissions.includes("terminal:access") || !permissions.includes("apps:manage"))
    return <p className="text-sm text-fg-muted">{t("aiAgents.permissionsRequired")}</p>;
  return (
    <>
      <p className="text-sm leading-relaxed text-fg-muted">{t("aiAgents.settingsHint")}</p>
      <AgentDiscovery
        onImported={(kind) => {
          setKind(kind);
          setConnection(null);
          setRevision((value) => value + 1);
        }}
        onConnect={(candidate) => {
          setKind(candidate.kind);
          setConnection(candidate);
          setRevision((value) => value + 1);
        }}
      />
      <Select
        label={t("aiAgents.agent")}
        value={kind}
        options={AI_AGENT_KINDS.map((value) => ({ value, label: t(`aiAgents.names.${value}`) }))}
        onChange={setKind}
      />
      <ResourceError error={error} />
      {agent ? (
        <AgentSettings
          key={`${kind}:${revision}`}
          agent={agent}
          initialConnection={connection?.kind === kind ? connection : undefined}
          onSaved={() => setConnection(null)}
        />
      ) : (
        <Button variant="secondary" loading={loading} onClick={() => void refresh()}>
          {t("common.refresh")}
        </Button>
      )}
    </>
  );
}
