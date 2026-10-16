import type { AiAgentKind, AiChatMessage } from "@everyos/shared";
import { Send, Square } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { cn } from "../../../lib/cn.ts";
import { ResourceError } from "../system/parts.tsx";
import { chatError } from "./chat-errors.ts";
import type { useAgentChat } from "./use-agent-chat.ts";

type Chat = ReturnType<typeof useAgentChat>;

/** One turn. Answers name the model that was asked, so a switch mid-chat stays visible. */
export function ChatMessage({
  message,
  kind,
  compact = false,
}: {
  message: AiChatMessage;
  kind: AiAgentKind;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const agent = t(`aiAgents.names.${kind}`);
  return (
    <article
      className={cn(
        "mx-auto max-w-3xl rounded-everyos-lg",
        compact ? "mb-2 p-2.5" : "mb-4 p-4",
        message.role === "user" ? "bg-accent/15" : "glass-inset",
      )}
    >
      <p
        className={cn("truncate text-xs font-semibold text-fg-muted", compact ? "mb-1" : "mb-2")}
        data-testid={message.role === "assistant" ? "ai-chat-answer-by" : undefined}
      >
        {message.role === "user"
          ? t("common.you")
          : message.model
            ? t("aiAgents.messageFrom", { agent, model: message.model })
            : agent}
      </p>
      <div
        className={cn(
          "whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]",
          compact ? "text-xs" : "text-sm",
        )}
      >
        {message.content}
      </div>
    </article>
  );
}

/** The scrolling transcript of the open chat, including the turn being streamed. */
export function ChatTranscript({
  chat,
  kind,
  compact = false,
  empty,
}: {
  chat: Chat;
  kind: AiAgentKind;
  compact?: boolean;
  empty: ReactNode;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [chat.conversation, chat.partial, chat.sending]);
  return (
    <div
      ref={scroll}
      className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "py-2" : "px-4 py-5")}
      role="log"
      aria-label={t("aiAgents.chat")}
      aria-live="polite"
      aria-busy={chat.pending || chat.reading}
      data-testid="ai-chat-messages"
    >
      {!chat.conversation?.messages.length && !chat.sending ? empty : null}
      {chat.conversation?.messages.map((message, index) => (
        <ChatMessage key={index} message={message} kind={kind} compact={compact} />
      ))}
      {chat.sending ? (
        <ChatMessage
          message={{ role: "user", content: chat.sending }}
          kind={kind}
          compact={compact}
        />
      ) : null}
      {chat.partial ? (
        <ChatMessage
          message={{ role: "assistant", content: chat.partial }}
          kind={kind}
          compact={compact}
        />
      ) : chat.pending ? (
        <p role="status" className="mx-auto max-w-3xl py-3 text-xs text-fg-muted">
          {t("aiAgents.thinking")}
        </p>
      ) : null}
    </div>
  );
}

/** Errors, the message box and send/stop. */
export function ChatComposer({
  chat,
  kind,
  available,
  compact = false,
  accessory,
}: {
  chat: Chat;
  kind: AiAgentKind;
  available: boolean;
  compact?: boolean;
  /** Shown above the message box (the widget's model menu). */
  accessory?: ReactNode;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const reason = chatError(t, kind, chat.error);
  return (
    <div className={cn("flex flex-col gap-2", compact ? "pt-2" : "border-t border-line p-3")}>
      {chat.conversation?.archived && !compact ? (
        <p className="text-xs text-fg-muted" role="note">
          {t("aiAgents.archivedNotice")}
        </p>
      ) : null}
      {reason ? (
        <Alert tone="warning" onDismiss={() => chat.setError(null)}>
          {reason}
        </Alert>
      ) : (
        <ResourceError error={chat.error} onDismiss={() => chat.setError(null)} />
      )}
      {accessory}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void chat.send();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {t("aiAgents.message")}
        </label>
        <textarea
          id={inputId}
          rows={compact ? 1 : 2}
          maxLength={16_000}
          value={chat.input}
          onChange={(event) => chat.setInput(event.target.value)}
          disabled={chat.pending || chat.reading || !available}
          placeholder={t("aiAgents.messagePlaceholder")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void chat.send();
            }
          }}
          className={cn(
            "glass-inset min-w-0 flex-1 resize-none rounded-everyos-md text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60",
            compact ? "max-h-24 min-h-9 p-2 text-xs" : "max-h-40 min-h-20 resize-y p-3 text-sm",
          )}
        />
        {chat.pending ? (
          <Button
            variant="secondary"
            size="icon"
            aria-label={t("aiAgents.cancelChat")}
            disabled={chat.reading}
            onClick={(event) => {
              event.preventDefault();
              void chat.cancel();
            }}
          >
            <Square className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!chat.input.trim() || !available || chat.reading}
            aria-label={t("aiAgents.send")}
          >
            <Send className="size-4" aria-hidden />
          </Button>
        )}
      </form>
      {!compact ? (
        <p className="text-[11px] leading-relaxed text-fg-subtle">{t("aiAgents.chatFooter")}</p>
      ) : null}
    </div>
  );
}
