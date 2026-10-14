import {
  AI_AGENT_KINDS,
  type AiAgentKind,
  type AiConversation,
  type AiChatMessage,
} from "@everyos/shared";
import { MessageCircle, Plus, Send, Settings, Square, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, ApiRequestError, postApiEvents } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { desktop } from "../../state/controller.ts";
import { useAppStateField } from "../app-context.ts";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { useAiAgents } from "./agent-store.ts";

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
  const agent = agents.find((entry) => entry.kind === kind);
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Select
          label={t("aiAgents.agent")}
          hideLabel
          value={kind}
          options={AI_AGENT_KINDS.map((value) => ({ value, label: t(`aiAgents.names.${value}`) }))}
          onChange={setKind}
          className="w-48"
        />
        {agent?.configured ? (
          <span className="truncate text-xs text-fg-muted" data-testid="ai-chat-model">
            {kind === "local" || agent.settings.mode === "external"
              ? agent.settings.apiModel
              : agent.settings.model}
          </span>
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
      <Chat key={`${sessionId}:${kind}`} kind={kind} />
    </div>
  );
}

function Chat({ kind }: { kind: AiAgentKind }) {
  const { t } = useTranslation();
  const agent = useAiAgents((state) => state.agents.find((entry) => entry.kind === kind));
  const refresh = useAiAgents((state) => state.refresh);
  const chatsRevision = useAiAgents((state) => state.chatsRevision);
  const locked = useSessionStore((state) => state.locked);
  const history = useApiResource<{ conversations: Omit<AiConversation, "messages">[] }>(
    `/ai-agents/${kind}/conversations`,
    null,
    chatsRevision,
  );
  const [conversation, setConversation] = useState<AiConversation | null>(null),
    [input, setInput] = useState("");
  const [pending, setPending] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(""),
    [partial, setPartial] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const request = useRef<AbortController | null>(null),
    revision = useRef(0),
    scroll = useRef<HTMLDivElement>(null);
  const inputId = useId();
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );
  useEffect(
    () =>
      useSessionStore.subscribe((state) => {
        if (state.locked || state.phase !== "authenticated") {
          request.current?.abort();
          setPending(false);
          setReading(false);
          setSending("");
          setPartial("");
          setInput("");
        }
      }),
    [],
  );
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [conversation, partial, sending]);
  const open = async (id: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++revision.current;
    setReading(true);
    setError(null);
    try {
      const result = await api<AiConversation>(`/ai-agents/${kind}/conversations/${id}`, {
        signal: controller.signal,
      });
      if (current === revision.current && !controller.signal.aborted) setConversation(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
    } finally {
      if (current === revision.current && !controller.signal.aborted) setReading(false);
    }
  };
  const send = async () => {
    const content = input.trim();
    if (!content || pending || reading || locked) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setSending(content);
    setPartial("");
    setInput("");
    try {
      const thread =
        conversation ??
        (await api<AiConversation>(`/ai-agents/${kind}/conversations`, {
          method: "POST",
          body: {},
          signal: controller.signal,
        }));
      if (controller.signal.aborted) return;
      setConversation(thread);
      await postApiEvents(
        `/ai-agents/${kind}/chat`,
        { conversationId: thread.id, content },
        controller.signal,
        (event, raw) => {
          if (controller.signal.aborted || useSessionStore.getState().locked) return;
          const data = raw as {
            text?: unknown;
            conversation?: AiConversation;
            code?: unknown;
            message?: unknown;
          };
          if (event === "delta" && typeof data.text === "string") {
            const text = data.text;
            setPartial((old) => old + text);
          }
          if (event === "complete" && data.conversation) {
            setConversation(data.conversation);
            setSending("");
            setPartial("");
          }
          if (event === "error")
            throw new ApiRequestError(502, "AGENT_OPERATION_FAILED", "Agent chat failed", {
              reason: typeof data.code === "string" ? data.code : "offline",
              message: typeof data.message === "string" ? data.message : undefined,
            });
        },
      );
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(error);
        setInput(content);
      }
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        setSending("");
        setPartial("");
        // A failed turn still leaves its newly created conversation in the list.
        history.reload();
      }
      void refresh();
    }
  };
  const cancel = async () => {
    request.current?.abort();
    request.current = null;
    setInput(sending);
    setReading(true);
    setSending("");
    setPartial("");
    if (conversation) {
      try {
        await api(`/ai-agents/${kind}/chat/cancel`, {
          method: "POST",
          body: { conversationId: conversation.id },
        });
      } catch (error) {
        if (!useSessionStore.getState().locked) setError(error);
      }
    }
    await refresh();
    setPending(false);
    setReading(false);
  };
  const remove = async () => {
    if (!conversation) return;
    setConfirmDelete(false);
    setReading(true);
    setError(null);
    try {
      await api(`/ai-agents/${kind}/conversations/${conversation.id}`, {
        method: "DELETE",
        body: { confirmId: conversation.id },
      });
      setConversation(null);
      history.reload();
    } catch (error) {
      setError(error);
    } finally {
      setReading(false);
    }
  };
  const available =
    agent?.status === "running" && agent.source === "host" && !agent.busy && !locked;
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col gap-3 border-r border-line p-3 max-sm:w-16">
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || reading}
          aria-label={t("aiAgents.newChat")}
          onClick={() => {
            revision.current++;
            request.current?.abort();
            setConversation(null);
            setInput("");
            setError(null);
          }}
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span className="max-sm:sr-only">{t("aiAgents.newChat")}</span>
        </Button>
        <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t("aiAgents.history")}>
          {history.data?.conversations.map((entry) => (
            <button
              type="button"
              key={entry.id}
              title={entry.title || t("aiAgents.untitled")}
              aria-label={entry.title || t("aiAgents.untitled")}
              disabled={pending || reading}
              aria-current={conversation?.id === entry.id ? "true" : undefined}
              onClick={() => void open(entry.id)}
              className={cn(
                "mb-1 flex w-full items-center gap-2 rounded-everyos-md p-2 text-left text-xs outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent",
                conversation?.id === entry.id && "bg-accent/15",
              )}
            >
              <MessageCircle className="size-4 shrink-0" aria-hidden />
              <span className="truncate max-sm:sr-only">
                {entry.title || t("aiAgents.untitled")}
              </span>
            </button>
          ))}
          <ResourceError error={history.error} />
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-fg-muted">
          <AiAgentIcon kind={kind} className="size-4" />
          <span role="status">
            {t(agent?.busy ? "aiAgents.busy" : `aiAgents.statuses.${agent?.status ?? "unknown"}`)}
          </span>
          <SimulatedBadge source={agent?.source} />
          {conversation ? (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              disabled={pending || reading}
              aria-label={t("aiAgents.deleteChat")}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) : null}
        </div>
        <div
          ref={scroll}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
          role="log"
          aria-label={t("aiAgents.chat")}
          aria-live="polite"
          aria-busy={pending || reading}
          data-testid="ai-chat-messages"
        >
          {!conversation?.messages.length && !sending ? (
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
          ) : null}
          {conversation?.messages.map((message, index) => (
            <Message key={index} message={message} kind={kind} />
          ))}
          {sending ? <Message message={{ role: "user", content: sending }} kind={kind} /> : null}
          {partial ? (
            <Message message={{ role: "assistant", content: partial }} kind={kind} />
          ) : pending ? (
            <p role="status" className="mx-auto max-w-3xl py-3 text-xs text-fg-muted">
              {t("aiAgents.thinking")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 border-t border-line p-3">
          {chatError(t, kind, error) ? (
            <Alert tone="warning" onDismiss={() => setError(null)}>
              {chatError(t, kind, error)}
            </Alert>
          ) : (
            <ResourceError error={error} onDismiss={() => setError(null)} />
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor={inputId}>
              {t("aiAgents.message")}
            </label>
            <textarea
              id={inputId}
              rows={2}
              maxLength={16_000}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={pending || reading || !available}
              placeholder={t("aiAgents.messagePlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="glass-inset max-h-40 min-h-20 min-w-0 flex-1 resize-y rounded-everyos-md p-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            />
            {pending ? (
              <Button
                variant="secondary"
                size="icon"
                aria-label={t("aiAgents.cancelChat")}
                disabled={reading}
                onClick={(event) => {
                  event.preventDefault();
                  void cancel();
                }}
              >
                <Square className="size-4" aria-hidden />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || !available || reading}
                aria-label={t("aiAgents.send")}
              >
                <Send className="size-4" aria-hidden />
              </Button>
            )}
          </form>
          <p className="text-[11px] leading-relaxed text-fg-subtle">{t("aiAgents.chatFooter")}</p>
        </div>
      </main>
      {confirmDelete ? (
        <Dialog open onOpenChange={setConfirmDelete} title={t("aiAgents.deleteChat")}>
          <Alert tone="warning">{t("aiAgents.deleteConfirm")}</Alert>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t("common.delete")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

const CHAT_ERROR_REASONS = ["auth", "offline", "status", "invalid", "too-large"] as const;

/** The agent's own failure reason when it gave one, instead of a generic system error. */
function chatError(t: TFunction, kind: AiAgentKind, error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.code !== "AGENT_OPERATION_FAILED") return null;
  const { reason, message } = (error.details ?? {}) as { reason?: unknown; message?: unknown };
  const agent = t(`aiAgents.names.${kind}`);
  if (reason === "agent-error")
    return typeof message === "string" && message
      ? t("aiAgents.chatErrors.agentReason", { agent, message })
      : t("aiAgents.chatErrors.agent", { agent });
  const known = CHAT_ERROR_REASONS.find((value) => value === reason);
  return known ? t(`aiAgents.chatErrors.${known}`, { agent }) : null;
}

function Message({ message, kind }: { message: AiChatMessage; kind: AiAgentKind }) {
  const { t } = useTranslation();
  return (
    <article
      className={cn(
        "mx-auto mb-4 max-w-3xl rounded-everyos-lg p-4",
        message.role === "user" ? "bg-accent/15" : "glass-inset",
      )}
    >
      <p className="mb-2 text-xs font-semibold text-fg-muted">
        {t(message.role === "user" ? "common.you" : `aiAgents.names.${kind}`)}
      </p>
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
        {message.content}
      </div>
    </article>
  );
}
