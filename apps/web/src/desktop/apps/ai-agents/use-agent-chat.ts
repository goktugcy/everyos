import type { AiAgentKind, AiConversation, AiConversationSummary } from "@everyos/shared";
import { useEffect, useRef, useState } from "react";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, postApiEvents } from "../../../lib/api.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { useAiAgents } from "./agent-store.ts";
import { streamError } from "./chat-errors.ts";

/** Every open chat list (window and widgets) reloads after a change made in any of them. */
function chatsChanged() {
  useAiAgents.setState((state) => ({ chatsRevision: state.chatsRevision + 1 }));
}

/** One assistant's chat: history, the open conversation and a streamed turn. */
export function useAgentChat(kind: AiAgentKind) {
  const refresh = useAiAgents((state) => state.refresh);
  const chatsRevision = useAiAgents((state) => state.chatsRevision);
  const locked = useSessionStore((state) => state.locked);
  const history = useApiResource<{ conversations: AiConversationSummary[] }>(
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
  const request = useRef<AbortController | null>(null),
    revision = useRef(0);
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
  const reset = () => {
    revision.current++;
    request.current?.abort();
    setConversation(null);
    setInput("");
    setError(null);
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
          if (event === "error") throw streamError(data);
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
        chatsChanged();
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
  const remove = async (id: string) => {
    setReading(true);
    setError(null);
    try {
      await api(`/ai-agents/${kind}/conversations/${id}`, {
        method: "DELETE",
        body: { confirmId: id },
      });
      if (conversation?.id === id) setConversation(null);
      chatsChanged();
    } catch (error) {
      setError(error);
    } finally {
      setReading(false);
    }
  };
  const update = async (id: string, patch: { favorite?: boolean; archived?: boolean }) => {
    setError(null);
    try {
      const summary = await api<AiConversationSummary>(`/ai-agents/${kind}/conversations/${id}`, {
        method: "PATCH",
        body: patch,
      });
      setConversation((current) => (current?.id === id ? { ...current, ...summary } : current));
      chatsChanged();
    } catch (error) {
      setError(error);
    }
  };
  return {
    history,
    conversation,
    input,
    setInput,
    pending,
    reading,
    error,
    setError,
    sending,
    partial,
    locked,
    open,
    reset,
    send,
    cancel,
    remove,
    update,
  };
}
