import type { AiAgentKind, ProcessDetail } from "@everyos/shared";
import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useAiAgents } from "../ai-agents/agent-store.ts";
import { ChatTranscript } from "../ai-agents/chat-parts.tsx";
import { useAgentChat } from "../ai-agents/use-agent-chat.ts";
import { ResourceError, SimulatedBadge } from "./parts.tsx";
import { processExplanationData } from "./process-explanation-data.ts";

export function ProcessExplanation({ detail }: { detail: ProcessDetail }) {
  const { t } = useTranslation();
  const { agents, refresh, loading, error } = useAiAgents();
  const ready = agents.filter(
    (agent) => agent.configured && agent.status === "running" && !agent.busy,
  );
  const [chosen, setChosen] = useState<AiAgentKind | null>(null);
  if (chosen === null && ready.length)
    setChosen(ready.find((agent) => agent.kind === "local")?.kind ?? ready[0]!.kind);
  const kind = chosen;
  const selected = agents.find((agent) => agent.kind === kind);
  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      aria-label={t("monitor.processes.explainTitle")}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("monitor.processes.explainTitle")}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t("common.refresh")}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>
      <ResourceError error={error} />
      {kind ? (
        <>
          <Select
            label={t("monitor.processes.assistant")}
            value={kind}
            onChange={setChosen}
            options={[...new Set([kind, ...ready.map((agent) => agent.kind)])].map((value) => ({
              value,
              label: t(`aiAgents.names.${value}`),
            }))}
          />
          <SimulatedBadge source={selected?.source} />
          <ExplanationChat
            key={kind}
            kind={kind}
            detail={detail}
            available={ready.some((agent) => agent.kind === kind)}
          />
        </>
      ) : (
        <p className="text-xs text-fg-muted">{t("monitor.processes.noAssistant")}</p>
      )}
    </section>
  );
}

function ExplanationChat({
  kind,
  detail,
  available,
}: {
  kind: AiAgentKind;
  detail: ProcessDetail;
  available: boolean;
}) {
  const { t } = useTranslation();
  const chat = useAgentChat(kind);
  const answerArea = useRef<HTMLDivElement>(null);
  const hasAnswer =
    !!chat.partial || !!chat.conversation?.messages.some((message) => message.role === "assistant");
  useEffect(() => {
    if (chat.pending || hasAnswer) answerArea.current?.scrollIntoView({ block: "nearest" });
  }, [chat.pending, hasAnswer]);
  return (
    <>
      <p className="text-xs text-fg-muted">{t("monitor.processes.explainPrivacy")}</p>
      <Button
        size="sm"
        disabled={!available || chat.pending || chat.reading || chat.locked}
        onClick={() =>
          void chat.send(
            t("monitor.processes.explainPrompt", {
              data: JSON.stringify(processExplanationData(detail)),
            }),
          )
        }
      >
        <Sparkles className="size-4" aria-hidden />
        {t("monitor.processes.explain")}
      </Button>
      {!available ? (
        <p role="status" className="text-xs text-fg-muted">
          {t("monitor.processes.noAssistant")}
        </p>
      ) : null}
      <ResourceError error={chat.error} />
      {chat.pending ? (
        <Button size="sm" variant="ghost" onClick={() => void chat.cancel()}>
          {t("aiAgents.cancelChat")}
        </Button>
      ) : null}
      {chat.pending || chat.conversation ? (
        <div
          ref={answerArea}
          className="flex h-64 max-h-[50vh] min-h-32 shrink-0 flex-col overflow-hidden rounded-everyos-sm border border-line px-2"
        >
          <ChatTranscript chat={chat} kind={kind} compact empty={null} showUserMessages={false} />
        </div>
      ) : null}
    </>
  );
}
