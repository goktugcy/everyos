import { AI_AGENT_KINDS, type AiAgentKind } from "@everyos/shared";
import { ExternalLink, History, Plus } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/cn.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { AiAgentIcon } from "../../apps/ai-agents/agent-icon.tsx";
import { useAiAgents } from "../../apps/ai-agents/agent-store.ts";
import { ChatComposer, ChatTranscript } from "../../apps/ai-agents/chat-parts.tsx";
import { ConversationList } from "../../apps/ai-agents/conversation-list.tsx";
import { ModelPicker } from "../../apps/ai-agents/model-picker.tsx";
import { useAgentChat } from "../../apps/ai-agents/use-agent-chat.ts";
import { SimulatedBadge } from "../../apps/system/parts.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";
import { desktop } from "../../state/controller.ts";
import { widgetActions } from "../actions.ts";
import type { WidgetRenderProps } from "./gate.tsx";

const tool =
  "grid size-7 shrink-0 place-items-center rounded-md text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";

/**
 * A desktop chat with the account's assistants. The assistant is chosen in the widget itself
 * (kept in its configuration); "auto" follows the first ready one, like the AI Chat window.
 */
export function AiChatWidget({ instance }: WidgetRenderProps) {
  const agents = useAiAgents((state) => state.agents);
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const setting = instance.config.agent;
  const [auto, setAuto] = useState<AiAgentKind | null>(null);
  if (setting === "auto" && auto === null && agents.length)
    setAuto(
      (
        agents.find((agent) => agent.configured && agent.status === "running") ??
        agents.find((agent) => agent.configured)
      )?.kind ?? "local",
    );
  const kind = AI_AGENT_KINDS.find((value) => value === setting) ?? auto ?? "local";
  return (
    <WidgetChat
      key={`${sessionId}:${kind}`}
      kind={kind}
      onKind={(next) =>
        widgetActions.update(instance.id, { config: { ...instance.config, agent: next } })
      }
    />
  );
}

function WidgetChat({ kind, onKind }: { kind: AiAgentKind; onKind: (kind: AiAgentKind) => void }) {
  const { t } = useTranslation();
  const agents = useAiAgents((state) => state.agents);
  const agent = agents.find((entry) => entry.kind === kind);
  const chat = useAgentChat(kind);
  const [historyOpen, setHistoryOpen] = useState(false);
  const idle = !chat.pending && !chat.reading;
  const available =
    agent?.status === "running" && agent.source === "host" && !agent.busy && !chat.locked;
  // Pick up where the last chat with this assistant left off.
  const resumed = useRef(false);
  const latest = chat.history.data?.conversations.find((entry) => !entry.archived);
  useEffect(() => {
    if (resumed.current || !chat.history.data) return;
    resumed.current = true;
    if (latest) void chat.open(latest.id);
  }, [chat, latest]);
  const name = t(`aiAgents.names.${kind}`);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ai-chat-widget">
      <div className="flex shrink-0 items-center gap-1">
        <div role="radiogroup" aria-label={t("aiAgents.widget.pick")} className="flex gap-0.5">
          {AI_AGENT_KINDS.map((value) => {
            const entry = agents.find((item) => item.kind === value);
            const label = `${t(`aiAgents.names.${value}`)}${entry?.configured ? "" : ` · ${t("aiAgents.widget.notConfigured")}`}`;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === kind}
                aria-label={label}
                title={label}
                disabled={!idle}
                onClick={() => value !== kind && onKind(value)}
                className={cn(
                  tool,
                  value === kind && "bg-[rgb(var(--everyos-accent)/0.22)] text-fg",
                  !entry?.configured && "opacity-50",
                )}
              >
                <AiAgentIcon kind={value} className="size-4" />
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <SimulatedBadge source={agent?.source} />
        <Popover.Root open={historyOpen} onOpenChange={setHistoryOpen}>
          <Popover.Trigger
            className={tool}
            aria-label={t("aiAgents.history")}
            title={t("aiAgents.history")}
            disabled={!idle}
          >
            <History className="size-4" aria-hidden />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              collisionPadding={8}
              aria-label={t("aiAgents.history")}
              className="glass-strong z-[8000] max-h-[min(420px,60vh)] w-64 overflow-y-auto rounded-everyos-lg p-2 text-fg"
            >
              <ConversationList
                conversations={chat.history.data?.conversations ?? []}
                activeId={chat.conversation?.id ?? null}
                disabled={!idle}
                onOpen={(id) => {
                  setHistoryOpen(false);
                  void chat.open(id);
                }}
                onUpdate={(id, patch) => void chat.update(id, patch)}
                onDelete={(id) =>
                  void requestConfirm({
                    title: t("aiAgents.deleteChat"),
                    body: t("aiAgents.deleteConfirm"),
                    confirmLabel: t("common.delete"),
                  }).then((ok) => {
                    if (ok) void chat.remove(id);
                  })
                }
              />
              {!chat.history.data?.conversations.length ? (
                <p className="p-2 text-xs text-fg-muted">{t("aiAgents.untitled")}</p>
              ) : null}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button
          type="button"
          className={tool}
          aria-label={t("aiAgents.newChat")}
          title={t("aiAgents.newChat")}
          disabled={!idle}
          onClick={chat.reset}
        >
          <Plus className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          className={tool}
          aria-label={t("aiAgents.widget.openApp")}
          title={t("aiAgents.widget.openApp")}
          onClick={() => desktop.openApp("everyos.agents", { appState: { kind } })}
        >
          <ExternalLink className="size-4" aria-hidden />
        </button>
      </div>
      <ChatTranscript
        chat={chat}
        kind={kind}
        compact
        empty={
          <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
            <AiAgentIcon kind={kind} className="size-8 text-accent" />
            <p className="text-xs leading-relaxed text-fg-muted">
              {available ? t("aiAgents.welcome", { agent: name }) : t("aiAgents.setupHint")}
            </p>
            {!available ? (
              <button
                type="button"
                className="rounded-everyos-sm bg-hover/10 px-2 py-1 text-xs font-medium text-fg hover:bg-hover/16"
                onClick={() => desktop.openSettings("agents", { agentKind: kind })}
              >
                {t("settings.sections.agents")}
              </button>
            ) : null}
          </div>
        }
      />
      <ChatComposer
        chat={chat}
        kind={kind}
        available={available}
        compact
        accessory={
          agent?.configured ? (
            <ModelPicker agent={agent} disabled={!idle} className="self-start" />
          ) : null
        }
      />
    </div>
  );
}
