import {
  AI_AGENT_KINDS,
  type AiAgentDiscovery,
  type AiAgentKind,
  type AiAgentView,
  type LocalModelsView,
} from "@everyos/shared";
import type { TFunction } from "i18next";
import { MessageCircle, Plus, Settings2, Wand2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { usePermissions } from "../../../stores/session-store.ts";
import { desktop } from "../../state/controller.ts";
import { AgentDiscovery } from "../ai-agents/agent-discovery.tsx";
import { AiAgentIcon } from "../ai-agents/agent-icon.tsx";
import { useAiAgents } from "../ai-agents/agent-store.ts";
import { AssistantEditor, StatusPill } from "../ai-agents/assistant-editor.tsx";
import { localServer, localSource } from "../ai-agents/assistant-form.tsx";
import { AssistantWizard } from "../ai-agents/assistant-wizard.tsx";
import { LocalModelsPanel, useLocalModels } from "../ai-agents/local-models-panel.tsx";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { useAppStateField } from "../app-context.ts";

const OPEN_TARGETS = [...AI_AGENT_KINDS, "none"] as const;

/** Where a configured assistant runs and which model it uses, in one line. */
function detail(agent: AiAgentView, local: LocalModelsView | null, t: TFunction): string | null {
  if (!agent.configured) return null;
  const settings = agent.settings;
  if (agent.kind === "local") {
    const server = localServer(localSource(settings, local), local);
    return `${settings.apiModel} · ${server?.name ?? settings.baseUrl.replace(/^https?:\/\//, "")}`;
  }
  if (settings.mode === "external")
    return t("aiAgents.overview.connectedTo", {
      address: settings.baseUrl.replace(/^https?:\/\//, ""),
    });
  return `${settings.model} · ${t(`aiAgents.providers.${settings.provider}`)}`;
}

function AssistantCard({
  agent,
  local,
  onSetup,
  onEdit,
}: {
  agent: AiAgentView;
  local: LocalModelsView | null;
  onSetup: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const line = detail(agent, local, t);
  return (
    <article
      className="glass-inset flex flex-wrap items-center gap-3 rounded-everyos-lg p-4"
      data-testid={`assistant-card-${agent.kind}`}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
        <AiAgentIcon kind={agent.kind} className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {t(`aiAgents.names.${agent.kind}`)}
          {agent.configured ? <StatusPill agent={agent} /> : null}
          <SimulatedBadge source={agent.source} />
        </h4>
        <p className="mt-1 truncate text-xs text-fg-muted">
          {line ?? t(`aiAgents.descriptions.${agent.kind}`)}
        </p>
      </div>
      {agent.configured ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={agent.status !== "running"}
            onClick={() => desktop.openApp("everyos.agents", { appState: { kind: agent.kind } })}
          >
            <MessageCircle className="size-4" aria-hidden />
            {t("aiAgents.quickChat")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            data-testid={`assistant-edit-${agent.kind}`}
          >
            <Settings2 className="size-4" aria-hidden />
            {t("aiAgents.overview.edit")}
          </Button>
        </div>
      ) : (
        <Button size="sm" onClick={onSetup} data-testid={`assistant-setup-${agent.kind}`}>
          <Wand2 className="size-4" aria-hidden />
          {t("aiAgents.overview.setup")}
        </Button>
      )}
    </article>
  );
}

export default function AgentsSection() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { agents, error, loading, refresh } = useAiAgents();
  const local = useLocalModels();
  const [target, setTarget] = useAppStateField("agentKind", OPEN_TARGETS, "none");
  const [wizard, setWizard] = useState<{ kind?: AiAgentKind } | null>(null),
    [editing, setEditing] = useState<{ kind: AiAgentKind; connection?: AiAgentDiscovery } | null>(
      null,
    );
  // "Settings" in the chat or menu bar asks for one assistant; it opens until closed.
  const requested = target === "none" ? undefined : agents.find((agent) => agent.kind === target);
  const wizardFor =
    wizard ?? (requested && !requested.configured ? { kind: requested.kind } : null);
  const editFor = editing ?? (requested?.configured ? { kind: requested.kind } : null);
  const close = () => {
    setWizard(null);
    setEditing(null);
    if (target !== "none") setTarget("none");
  };
  if (!permissions.includes("terminal:access") || !permissions.includes("apps:manage"))
    return <p className="text-sm text-fg-muted">{t("aiAgents.permissionsRequired")}</p>;
  const editingAgent = editFor ? agents.find((agent) => agent.kind === editFor.kind) : undefined;
  return (
    <>
      <p className="text-sm leading-relaxed text-fg-muted">{t("aiAgents.settingsHint")}</p>
      <section className="flex flex-col gap-3" aria-label={t("aiAgents.overview.title")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("aiAgents.overview.title")}</h3>
          <Button size="sm" onClick={() => setWizard({})} data-testid="assistant-add">
            <Plus className="size-4" aria-hidden />
            {t("aiAgents.overview.add")}
          </Button>
        </div>
        <ResourceError error={error} />
        {agents.length ? (
          agents.map((agent) => (
            <AssistantCard
              key={agent.kind}
              agent={agent}
              local={local.data}
              onSetup={() => setWizard({ kind: agent.kind })}
              onEdit={() => setEditing({ kind: agent.kind })}
            />
          ))
        ) : (
          <Button variant="secondary" loading={loading} onClick={() => void refresh()}>
            {t("common.refresh")}
          </Button>
        )}
      </section>
      <section className="flex flex-col gap-3" aria-label={t("aiAgents.local.title")}>
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{t("aiAgents.local.title")}</h3>
          <p className="text-xs leading-relaxed text-fg-muted">{t("aiAgents.local.hint")}</p>
        </div>
        <LocalModelsPanel local={local.data} error={local.error} reload={local.reload} />
      </section>
      <AgentDiscovery
        onImported={() => {
          void refresh();
          local.reload();
        }}
        onConnect={(candidate) => setEditing({ kind: candidate.kind, connection: candidate })}
      />
      {wizardFor ? (
        <AssistantWizard
          agents={agents}
          local={local.data}
          reloadLocal={local.reload}
          initialKind={wizardFor.kind}
          onClose={close}
        />
      ) : null}
      {editingAgent ? (
        <AssistantEditor
          key={`${editingAgent.kind}:${editing?.connection?.id ?? ""}`}
          agent={editingAgent}
          local={local.data}
          reloadLocal={local.reload}
          initialConnection={editing?.connection}
          onClose={close}
        />
      ) : null}
    </>
  );
}
