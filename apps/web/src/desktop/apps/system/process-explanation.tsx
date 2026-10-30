import type { AiAgentKind, AiAgentView, ProcessDetail } from "@everyos/shared";
import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Alert } from "../../../components/ui/alert.tsx";
import { useAiAgents } from "../ai-agents/agent-store.ts";
import { ChatMessage } from "../ai-agents/chat-parts.tsx";
import { chatError } from "../ai-agents/chat-errors.ts";
import { ModelPicker } from "../ai-agents/model-picker.tsx";
import { ResourceError, SimulatedBadge } from "./parts.tsx";
import { useProcessExplanation } from "./use-process-explanation.ts";

export function ProcessExplanation({ detail }: { detail: ProcessDetail }) {
  const { t } = useTranslation();
  const { agents, refresh, loading, error } = useAiAgents();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let mounted = true;
    void refresh().finally(() => {
      if (mounted) setChecked(true);
    });
    return () => {
      mounted = false;
    };
  }, [refresh]);
  const connected = agents.filter((agent) => agent.configured && agent.status === "running");
  const [chosen, setChosen] = useState<AiAgentKind | null>(null);
  if (chosen === null && connected.length)
    setChosen(
      connected.find((agent) => agent.kind === "local" && !agent.busy)?.kind ??
        connected.find((agent) => !agent.busy)?.kind ??
        connected[0]!.kind,
    );
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
            options={[...new Set([kind, ...connected.map((agent) => agent.kind)])].map((value) => ({
              value,
              label: t(`aiAgents.names.${value}`),
            }))}
          />
          <SimulatedBadge source={selected?.source} />
          <ExplanationChat
            key={kind}
            kind={kind}
            detail={detail}
            available={connected.some((agent) => agent.kind === kind) && !selected?.busy}
            busy={selected?.busy ?? false}
            status={selected?.status ?? "unknown"}
          />
        </>
      ) : (
        <p role="status" className="text-xs text-fg-muted">
          {!checked || loading
            ? t("common.loading")
            : error
              ? null
              : t("monitor.processes.noAssistant")}
        </p>
      )}
    </section>
  );
}

function ExplanationChat({
  kind,
  detail,
  available,
  busy,
  status,
}: {
  kind: AiAgentKind;
  detail: ProcessDetail;
  available: boolean;
  busy: boolean;
  status: AiAgentView["status"];
}) {
  const { t, i18n } = useTranslation();
  const chat = useProcessExplanation(kind, detail, i18n.resolvedLanguage ?? i18n.language);
  const agent = useAiAgents((state) => state.agents.find((entry) => entry.kind === kind));
  const answerArea = useRef<HTMLDivElement>(null);
  const hasAnswer = !!chat.partial || !!chat.result;
  useEffect(() => {
    if (chat.pending || hasAnswer) answerArea.current?.scrollIntoView({ block: "nearest" });
  }, [chat.pending, hasAnswer]);
  return (
    <>
      <p className="text-xs text-fg-muted">{t("monitor.processes.explainPrivacy")}</p>
      <p className="text-xs font-medium">
        {t("monitor.processes.explanationFor", {
          name: chat.result?.name ?? detail.name,
          pid: detail.pid,
        })}
      </p>
      {agent?.configured ? (
        <ModelPicker agent={agent} disabled={chat.pending || busy || chat.locked} />
      ) : null}
      <Button
        size="sm"
        disabled={!available || chat.pending || chat.locked}
        onClick={() => void chat.run()}
      >
        <Sparkles className="size-4" aria-hidden />
        {t("monitor.processes.explain")}
      </Button>
      {!available && !chat.pending ? (
        <p role="status" className="text-xs text-fg-muted">
          {busy ? t("aiAgents.busy") : t(`aiAgents.statuses.${status}`)}
        </p>
      ) : null}
      {chatError(t, kind, chat.error) ? (
        <Alert tone="warning">{chatError(t, kind, chat.error)}</Alert>
      ) : (
        <ResourceError error={chat.error} />
      )}
      {chat.pending ? (
        <Button size="sm" variant="ghost" onClick={chat.cancel}>
          {t("aiAgents.cancelChat")}
        </Button>
      ) : null}
      {chat.pending || hasAnswer ? (
        <div
          ref={answerArea}
          className="flex h-64 max-h-[50vh] min-h-32 shrink-0 flex-col overflow-hidden rounded-everyos-sm border border-line px-2"
        >
          <div
            role="log"
            aria-live="polite"
            aria-busy={chat.pending}
            aria-label={t("aiAgents.chat")}
            data-testid="ai-chat-messages"
            className="min-h-0 flex-1 overflow-y-auto py-2"
          >
            {chat.partial || chat.result ? (
              <ChatMessage
                kind={kind}
                compact
                message={{
                  role: "assistant",
                  content: chat.partial || chat.result!.answer,
                  ...(chat.result?.model ? { model: chat.result.model.model } : {}),
                }}
              />
            ) : (
              <p role="status" className="py-3 text-xs text-fg-muted">
                {t("aiAgents.thinking")}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
