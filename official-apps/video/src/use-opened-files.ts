import { BridgeError, type FileHandle } from "@everyos/app-sdk";
import { useApp, useT } from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import { openedFiles } from "./opened-files.ts";

/** Repository-shared file handoff; it uses the existing SDK and never requests a picker. */
export function useOpenedFiles(options: {
  ready?: boolean;
  accept?: readonly string[];
  open: (files: FileHandle[]) => void | Promise<void>;
  error: (cause: unknown) => void;
}) {
  const app = useApp();
  const t = useT();
  const [state, setState] = useState(app.window.initialState);
  const callbacks = useRef(options);
  const handled = useRef<string | null>(null);
  const ready = options.ready ?? true;
  useEffect(() => {
    callbacks.current = options;
  }, [options]);
  useEffect(() => app.window.onOpened(setState), [app]);
  useEffect(() => {
    const request = openedFiles(state);
    if (!ready || !request || request.requestId === handled.current) return;
    let cancelled = false;
    void Promise.resolve()
      .then(async () => {
        if (cancelled) return;
        handled.current = request.requestId;
        if (request.error) throw new BridgeError(request.error, t("ui.errorText"));
        const { accept, open } = callbacks.current;
        const files = request.files.filter(
          (file) =>
            !accept ||
            accept.some((extension) => file.name.toLowerCase().endsWith(extension.toLowerCase())),
        );
        if (files.length) await open(files);
      })
      .catch((error: unknown) => {
        if (!cancelled) callbacks.current.error(error);
      });
    return () => {
      cancelled = true;
    };
  }, [app, state, ready, t]);
}
