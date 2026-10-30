import {
  DEFAULT_LOCALE,
  isLocale,
  type AiAgentKind,
  type ProcessDetail,
  type ProcessExplanationResult,
} from "@everyos/shared";
import { useEffect, useRef, useState } from "react";
import { postApiEvents } from "../../../lib/api.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { useAiAgents } from "../ai-agents/agent-store.ts";
import { streamError } from "../ai-agents/chat-errors.ts";

/** A diagnostic snapshot has its own lifetime, never a general assistant conversation. */
export function useProcessExplanation(kind: AiAgentKind, detail: ProcessDetail, language: string) {
  const [pending, setPending] = useState(false);
  const [partial, setPartial] = useState("");
  const [result, setResult] = useState<ProcessExplanationResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const locked = useSessionStore((state) => state.locked);
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const request = useRef<AbortController | null>(null);
  const clear = () => {
    request.current?.abort();
    request.current = null;
    setPending(false);
    setPartial("");
  };
  useEffect(() => {
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (
        state.locked ||
        state.phase !== "authenticated" ||
        state.session?.session.id !== sessionId
      ) {
        clear();
        setResult(null);
        setError(null);
      }
    });
    return () => {
      unsubscribe();
      request.current?.abort();
      request.current = null;
    };
  }, [sessionId]);
  const run = async () => {
    const session = useSessionStore.getState();
    if (
      request.current ||
      session.locked ||
      session.phase !== "authenticated" ||
      session.session?.session.id !== sessionId
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setPartial("");
    setResult(null);
    setError(null);
    try {
      await postApiEvents(
        `/ai-agents/${kind}/process-explanation`,
        {
          pid: detail.pid,
          ...(detail.startedAt === null ? {} : { startedAt: detail.startedAt }),
          locale: isLocale(language) ? language : DEFAULT_LOCALE,
        },
        controller.signal,
        (event, raw) => {
          const session = useSessionStore.getState();
          if (
            controller.signal.aborted ||
            session.locked ||
            session.phase !== "authenticated" ||
            session.session?.session.id !== sessionId
          )
            return;
          const data = raw as Partial<ProcessExplanationResult> & {
            text?: unknown;
            code?: unknown;
            message?: unknown;
          };
          if (event === "delta" && typeof data.text === "string") {
            const text = data.text;
            setPartial((value) => value + text);
          }
          if (event === "complete") {
            setResult(data as ProcessExplanationResult);
            setPartial("");
          }
          if (event === "error") throw streamError(data);
        },
      );
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
      void useAiAgents.getState().refresh();
    }
  };
  const cancel = () => {
    clear();
    void useAiAgents.getState().refresh();
  };
  return { pending, partial, result, error, locked, run, cancel };
}
