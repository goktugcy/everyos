import { useApp } from "@everyos/app-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteMeta, NotesStore } from "./store.ts";

export type DraftStatus = "idle" | "editing" | "saving" | "saved" | "failed";

const SAVE_DELAY_MS = 600;

/**
 * The text of the open note. Typing saves after a short pause, and always before another note
 * opens, the window goes to the background, closes or reloads, so nothing typed is lost.
 */
export function useDraft(
  store: NotesStore,
  id: string | null,
  onSaved: (meta: NoteMeta, text: string) => void,
  onFailed: (error: unknown) => void,
) {
  const app = useApp();
  const [text, setTextState] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [status, setStatus] = useState<DraftStatus>("idle");
  const pending = useRef<{ id: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ onSaved, onFailed });
  useEffect(() => {
    callbacks.current = { onSaved, onFailed };
  });

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setStatus("saving");
    try {
      const meta = await store.save(next.id, next.text);
      if (meta) callbacks.current.onSaved(meta, next.text);
      setStatus((current) => (current === "saving" ? "saved" : current));
    } catch (error) {
      // Kept for the next attempt, unless something newer was typed meanwhile.
      pending.current ??= next;
      setStatus("failed");
      callbacks.current.onFailed(error);
    }
  }, [store]);

  useEffect(() => {
    let stale = false;
    void flush().then(async () => {
      if (!id) {
        if (!stale) {
          setLoadedId(null);
          setTextState("");
        }
        return;
      }
      const body = await store.read(id);
      if (stale) return;
      setTextState(body);
      setLoadedId(id);
      setStatus("idle");
    });
    return () => {
      stale = true;
    };
  }, [id, store, flush]);

  useEffect(() => {
    const stopSuspend = app.lifecycle.onSuspend(() => void flush());
    const onHide = () => void flush();
    window.addEventListener("pagehide", onHide);
    void app.lifecycle.guardClose(async () => {
      await flush();
      return true;
    });
    return () => {
      stopSuspend();
      window.removeEventListener("pagehide", onHide);
      void app.lifecycle.guardClose(null);
      void flush();
    };
  }, [app, flush]);

  const setText = useCallback(
    (next: string) => {
      if (!id || loadedId !== id) return;
      setTextState(next);
      pending.current = { id, text: next };
      setStatus("editing");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [id, loadedId, flush],
  );

  /** Reads the note again (changed elsewhere), unless there is unsaved typing. */
  const reload = useCallback(
    async (text?: string) => {
      if (!id || pending.current) return;
      const body = text ?? (await store.read(id));
      if (!pending.current) setTextState(body);
    },
    [id, store],
  );

  return { text, setText, status, flush, reload, loaded: loadedId !== null && loadedId === id };
}
