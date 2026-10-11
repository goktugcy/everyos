import type { TerminalSessionView, TerminalStatus } from "@otuken/shared";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { List, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { registerBeforeSignOut, useSessionStore } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { isDesktopShortcut } from "../../shortcut-keys.ts";
import { windowManager } from "../../state/window-store.ts";
import { useAppHost } from "../app-context.ts";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { TerminalConnection, type ConnectionState } from "./connection.ts";
import { debounceResize, readSession, saveSession, sessionKey, terminalSize } from "./helpers.ts";
import { terminalOptions } from "./theme.ts";

function Sessions({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const userId = useSessionStore((state) => state.session?.user.id);
  const resource = useApiResource<{ sessions: TerminalSessionView[] }>("/terminal/sessions", 5_000);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const end = async (session: TerminalSessionView) => {
    if (
      !(await requestConfirm({
        title: t("terminal.sessions.endTitle"),
        body: t("terminal.sessions.endBody", { account: session.account }),
        confirmLabel: t("terminal.sessions.end"),
      }))
    )
      return;
    setBusy(session.id);
    setError(null);
    try {
      await api(`/terminal/sessions/${session.id}`, { method: "DELETE" });
      resource.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };
  const sessions = resource.data?.sessions.filter((session) => session.userId === userId);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("terminal.sessions.title")}
      description={t("terminal.sessions.hint")}
    >
      <div className="flex flex-col gap-3">
        {error ? <Alert>{errorMessage(t, error)}</Alert> : null}
        {resource.loading ? (
          <LoadingBlock />
        ) : resource.error ? (
          <ResourceError error={resource.error} />
        ) : null}
        {sessions?.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("terminal.sessions.empty")}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {sessions?.map((session) => (
            <li
              key={session.id}
              className="glass-inset flex items-center gap-3 rounded-otk-sm p-3"
              data-testid="terminal-session"
            >
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-mono font-medium">{session.account}</p>
                <p className="text-xs text-fg-muted">
                  {t(
                    session.attached ? "terminal.sessions.attached" : "terminal.sessions.detached",
                  )}
                </p>
                <p className="text-xs text-fg-subtle">
                  {t("terminal.sessions.started", {
                    time: formatDateTime(session.startedAt, i18n.language),
                  })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={session.attached || busy !== null}
                loading={busy === session.id}
                onClick={() => void end(session)}
              >
                <Trash2 className="size-4" aria-hidden />
                {t("terminal.sessions.end")}
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" onClick={resource.reload}>
          <RefreshCw className="size-4" aria-hidden />
          {t("common.refresh")}
        </Button>
      </div>
    </Dialog>
  );
}

function TerminalPane({ restart }: { restart: () => void }) {
  const { t } = useTranslation();
  const { windowId } = useAppHost();
  const userId = useSessionStore((state) => state.session?.user.id);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const [state, setState] = useState<ConnectionState>({ phase: "connecting" });
  const [sessions, setSessions] = useState(false);
  const inputLabel = t("terminal.input");
  const outputLimit = t("terminal.outputLimit");

  useEffect(() => {
    Terminal.strings.promptLabel = inputLabel;
    Terminal.strings.tooMuchOutput = outputLimit;
    terminal.current?.textarea?.setAttribute("aria-label", inputLabel);
  }, [inputLabel, outputLimit]);

  useEffect(() => {
    const element = container.current;
    if (!element || !userId) return;
    let disposed = false;
    let leaving = false;
    let connection: TerminalConnection | null = null;
    const xterm = new Terminal({
      ...terminalOptions(element),
      cursorBlink: true,
      screenReaderMode: true,
      scrollback: 2_000,
      allowProposedApi: false,
      linkHandler: { activate: () => undefined },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element);
    terminal.current = xterm;
    const resize = debounceResize((size) => connection?.resize(size));
    const fitWindow = () => {
      if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
      const size = terminalSize(xterm.cols, xterm.rows);
      if (size.cols !== xterm.cols || size.rows !== xterm.rows) xterm.resize(size.cols, size.rows);
      resize.push(size.cols, size.rows);
    };
    const connect = () => {
      connection = new TerminalConnection({
        key: sessionKey(userId, windowId),
        size: () => ({ cols: xterm.cols, rows: xterm.rows }),
        state: (next) => {
          setState(next);
          xterm.options.disableStdin = next.phase !== "connected";
        },
        output: (bytes) => xterm.write(bytes),
        reset: () => xterm.reset(),
      });
      connection.start();
    };
    const input = xterm.onData((data) => connection?.input(data));
    // Preserve native copy/paste, including Ctrl+C when there is a selection.
    xterm.attachCustomKeyEventHandler((event) => {
      if (isDesktopShortcut(event)) return false;
      const copy = event.code === "KeyC" && xterm.hasSelection();
      const paste = event.code === "KeyV";
      return !(!event.altKey && (event.ctrlKey || event.metaKey) && (copy || paste));
    });
    const copy = (event: ClipboardEvent) => {
      if (!xterm.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", xterm.getSelection());
      event.preventDefault();
    };
    element.addEventListener("copy", copy);
    const observer = new ResizeObserver(fitWindow);
    observer.observe(element);
    const theme = new MutationObserver(() => {
      xterm.options = terminalOptions(element);
      fitWindow();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-scheme"],
    });
    const onHide = () => {
      leaving = true;
      resize.cancel();
      connection?.dispose(false);
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted && !disposed) {
        leaving = false;
        fitWindow();
        connect();
      }
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    const unsubscribe = windowManager.subscribe((next, previous) => {
      if (previous.windows[windowId] && !next.windows[windowId]) connection?.dispose(true);
    });
    const unregister = registerBeforeSignOut(() => connection?.end() ?? Promise.resolve());
    // Defer opening the socket so StrictMode's setup/cleanup probe creates no shell.
    queueMicrotask(() => {
      if (disposed) return;
      fitWindow();
      connect();
      xterm.focus();
    });
    return () => {
      disposed = true;
      const currentUser = useSessionStore.getState().session?.user.id;
      connection?.dispose(
        !leaving &&
          (windowId === "mobile" ||
            !windowManager.getState().windows[windowId] ||
            currentUser !== userId),
      );
      unsubscribe();
      unregister();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      element.removeEventListener("copy", copy);
      observer.disconnect();
      theme.disconnect();
      resize.cancel();
      input.dispose();
      xterm.dispose();
      terminal.current = null;
    };
  }, [userId, windowId]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="terminal-app"
      data-terminal-phase={state.phase}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <SquareTerminal className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-fg-muted" role="status">
          {state.phase === "connected"
            ? t("terminal.account", { account: state.account, shell: state.shell })
            : t(`terminal.connection.${state.phase}`)}
        </p>
        {state.phase === "connected" && state.resumed ? (
          <span className="text-success">{t("terminal.resumed")}</span>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setSessions(true)}>
          <List className="size-4" aria-hidden />
          {t("terminal.sessions.title")}
        </Button>
      </div>
      <div
        ref={container}
        data-terminal-input
        className="min-h-0 flex-1 overflow-hidden p-2 font-mono text-sm"
      />
      {state.phase === "ended" ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2">
          <p className="min-w-0 text-sm text-fg-muted" role="status">
            {t(`terminal.reasons.${state.reason}`)}
            {state.code !== null ? ` ${t("terminal.exitCode", { code: state.code })}` : ""}
          </p>
          <Button size="sm" onClick={restart}>
            {t("terminal.newSession")}
          </Button>
        </div>
      ) : null}
      {sessions ? <Sessions onClose={() => setSessions(false)} /> : null}
    </div>
  );
}

export default function TerminalApp() {
  const { t } = useTranslation();
  const { windowId } = useAppHost();
  const userId = useSessionStore((state) => state.session?.user.id);
  const status = useApiResource<TerminalStatus>("/terminal/status", null);
  const [generation, setGeneration] = useState(0);
  const [sessions, setSessions] = useState(false);
  useEffect(() => {
    if (!userId || (!status.loading && !status.error && status.data?.enabled)) return;
    // A restored window can be closed before status loads and the pane mounts.
    return windowManager.subscribe((next, previous) => {
      if (!previous.windows[windowId] || next.windows[windowId]) return;
      const key = sessionKey(userId, windowId);
      const id = readSession(key);
      if (!id) return;
      saveSession(key, null);
      void api(`/terminal/sessions/${id}`, { method: "DELETE", keepalive: true }).catch(
        () => undefined,
      );
    });
  }, [windowId, userId, status.loading, status.error, status.data?.enabled]);
  if (status.loading) return <LoadingBlock />;
  if (status.error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <ResourceError error={status.error} />
        <Button variant="secondary" onClick={status.reload}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!status.data) return null;
  if (!status.data.enabled)
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center"
        data-testid="terminal-disabled"
      >
        <SquareTerminal className="size-9 text-fg-subtle" aria-hidden />
        <h3 className="text-lg font-semibold">{t("terminal.disabled.title")}</h3>
        <p className="max-w-lg text-sm text-fg-muted">
          {t(`terminal.disabled.${status.data.reason}`)}
        </p>
        <p className="max-w-lg text-sm text-fg-muted">{t("terminal.disabled.configure")}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={status.reload}>
            {t("common.retry")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSessions(true)}>
            {t("terminal.sessions.title")}
          </Button>
        </div>
        {sessions ? <Sessions onClose={() => setSessions(false)} /> : null}
      </div>
    );
  return <TerminalPane key={generation} restart={() => setGeneration((value) => value + 1)} />;
}
