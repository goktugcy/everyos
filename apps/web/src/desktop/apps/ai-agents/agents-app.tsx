import { AI_AGENT_KINDS, type AiAgentKind } from "@everyos/shared";
import { Plus, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useSessionStore } from "../../../stores/session-store.ts";
import { desktop } from "../../state/controller.ts";
import { useAppStateField } from "../app-context.ts";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { useAiAgents } from "./agent-store.ts";
import { ChatComposer, ChatTranscript } from "./chat-parts.tsx";
import { ConversationList } from "./conversation-list.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { useAgentChat } from "./use-agent-chat.ts";

const CHAT_TARGETS = [...AI_AGENT_KINDS, "auto"] as const;

export default function AgentsApp() {
  const [chosen, setKind] = useAppStateField("kind", CHAT_TARGETS, "auto");
  const agents = useAiAgents((state) => state.agents);
  // Without a choice, open the first ready assistant, then the first one that is set up. The pick
  // is kept, so a later status change never switches away from (and aborts) a running chat.
  const [auto, setAuto] = useState<AiAgentKind | null>(null);
  if (chosen === "auto" && auto === null && agents.length)
    setAuto(
      (
        agents.find((agent) => agent.configured && agent.status === "running") ??
        agents.find((agent) => agent.configured)
      )?.kind ?? "local",
    );
  const kind = chosen !== "auto" ? chosen : (auto ?? "local");
  const sessionId = useSessionStore((state) => state.session?.session.id);
  return <Chat key={`${sessionId}:${kind}`} kind={kind} onKind={setKind} />;
}

function Chat({ kind, onKind }: { kind: AiAgentKind; onKind: (kind: AiAgentKind) => void }) {
  const { t } = useTranslation();
  const agent = useAiAgents((state) => state.agents.find((entry) => entry.kind === kind));
  const chat = useAgentChat(kind);
  const [deleting, setDeleting] = useState<string | null>(null);
  const available =
    agent?.status === "running" && agent.source === "host" && !agent.busy && !chat.locked;
  const idle = !chat.pending && !chat.reading;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Select
          label={t("aiAgents.agent")}
          hideLabel
          value={kind}
          options={AI_AGENT_KINDS.map((value) => ({ value, label: t(`aiAgents.names.${value}`) }))}
          onChange={onKind}
          className="w-48"
        />
        {agent?.configured ? (
          <ModelPicker agent={agent} disabled={!idle} className="max-w-64" />
        ) : null}
        <Button
          variant="ghost"
          className="ml-auto"
          size="sm"
          onClick={() => desktop.openSettings("agents", { agentKind: kind })}
        >
          <Settings className="size-4" aria-hidden />
          {t("settings.sections.agents")}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col gap-3 border-r border-line p-3 max-sm:w-16">
          <Button
            variant="secondary"
            size="sm"
            disabled={!idle}
            aria-label={t("aiAgents.newChat")}
            onClick={chat.reset}
          >
            <Plus className="size-4 shrink-0" aria-hidden />
            <span className="max-sm:sr-only">{t("aiAgents.newChat")}</span>
          </Button>
          <nav className="min-h-0 flex-1 overflow-y-auto" aria-label={t("aiAgents.history")}>
            <ConversationList
              conversations={chat.history.data?.conversations ?? []}
              activeId={chat.conversation?.id ?? null}
              disabled={!idle}
              narrow
              onOpen={(id) => void chat.open(id)}
              onUpdate={(id, patch) => void chat.update(id, patch)}
              onDelete={setDeleting}
            />
            <ResourceError error={chat.history.error} />
          </nav>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-fg-muted">
            <AiAgentIcon kind={kind} className="size-4" />
            <span role="status">
              {t(agent?.busy ? "aiAgents.busy" : `aiAgents.statuses.${agent?.status ?? "unknown"}`)}
            </span>
            <SimulatedBadge source={agent?.source} />
            {chat.conversation ? (
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                disabled={!idle}
                aria-label={t("aiAgents.deleteChat")}
                onClick={() => setDeleting(chat.conversation!.id)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
          <ChatTranscript
            chat={chat}
            kind={kind}
            empty={
              <div className="mx-auto flex max-w-lg flex-col items-center gap-4 py-12 text-center">
                <AiAgentIcon kind={kind} className="size-12 text-accent" />
                <h2 className="text-lg font-semibold">
                  {t("aiAgents.welcome", { agent: t(`aiAgents.names.${kind}`) })}
                </h2>
                <p className="text-sm leading-relaxed text-fg-muted">
                  {available
                    ? t(kind === "local" ? "aiAgents.descriptions.local" : "aiAgents.chatHint")
                    : t("aiAgents.setupHint")}
                </p>
                {!available ? (
                  <Button
                    variant="secondary"
                    onClick={() => desktop.openSettings("agents", { agentKind: kind })}
                  >
                    {t("settings.sections.agents")}
                  </Button>
                ) : null}
              </div>
            }
          />
          <ChatComposer chat={chat} kind={kind} available={available} />
        </main>
      </div>
      {deleting ? (
        <Dialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={t("aiAgents.deleteChat")}
        >
          <Alert tone="warning">{t("aiAgents.deleteConfirm")}</Alert>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = deleting;
                setDeleting(null);
                void chat.remove(id);
              }}
            >
              {t("common.delete")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
