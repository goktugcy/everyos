import { APP_FRAME_SANDBOX, APP_SDK_VERSION } from "@everyos/app-manifest";
import { INIT_TYPE, PROTOCOL, type HelloMessage } from "@everyos/app-sdk/protocol";
import { EVERYOS_VERSION, type DesktopAppInstallationView } from "@everyos/shared";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18next } from "../../app/i18n.ts";
import { Button } from "../../components/ui/button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { api } from "../../lib/api.ts";
import { randomId } from "../../lib/random-id.ts";
import type { AppHost } from "../apps/app-context.ts";
import { windowManager } from "../state/window-store.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import { setCloseGuard } from "../windows/close-guards.ts";
import { AppDialog, type PendingDialog } from "./app-dialog.tsx";
import { FilePicker, type PickerRequest, type PickerResult } from "./file-picker.tsx";
import { useAppBadges } from "./badges.ts";
import { retireLater } from "./retire.ts";
import { AppBridge } from "./bridge.ts";
import { createHandlers, INSTANCE_HEADER, windowState } from "./handlers.ts";
import { useDesktopApps } from "./store.ts";
import { themeSnapshot } from "./theme-snapshot.ts";

/** What the frame may do (shared with the runtime CSP and the developer tools). */
export { APP_FRAME_SANDBOX };

const READY_FALLBACK_MS = 4000;
const CLOSE_DECISION_MS = 10_000;

type Phase = "connecting" | "ready" | "failed" | "stopped";

/**
 * One sandboxed app document (a window or a widget) and its bridge. The frame has an opaque
 * origin; it gets a private port on every load and nothing else from the desktop.
 */
export function AppFrame({
  app,
  kind,
  widgetId = null,
  entry,
  host,
  className,
}: {
  app: DesktopAppInstallationView;
  kind: "window" | "widget";
  widgetId?: string | null;
  entry: string;
  host: AppHost | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const name = useDesktopApps((state) => state.names[app.appId] ?? app.name);
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [dialogs, setDialogs] = useState<PendingDialog[]>([]);
  const [picker, setPicker] = useState<{
    request: PickerRequest;
    resolve: (result: PickerResult | null) => void;
  } | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const hostRef = useRef(host);
  // The window state the app knows: what it was started with or saved itself.
  const knownState = useRef<unknown>(undefined);
  // Declared before the frame effect, so it runs first in every commit.
  useEffect(() => {
    hostRef.current = host;
  }, [host]);
  // Opened again with new state (a widget opening a note …): the running app hears it.
  const appState = host?.appState;
  useEffect(() => {
    if (kind !== "window" || appState === undefined || appState === knownState.current) return;
    knownState.current = appState;
    bridgeRef.current?.emit("window.opened", { state: appState });
  }, [kind, appState]);

  const showDialog = useCallback(
    (request: Parameters<Parameters<typeof createHandlers>[0]["showDialog"]>[0]) =>
      new Promise<boolean | string | null>((resolve) => {
        const id = Math.random();
        const done = (value: boolean | string | null) => {
          setDialogs((list) => list.filter((entry) => entry.id !== id));
          resolve(value);
        };
        setDialogs((list) => [...list, { ...request, id, resolve: done }]);
      }),
    [],
  );

  const showPicker = useCallback(
    (request: PickerRequest) =>
      new Promise<PickerResult | null>((resolve) => {
        // One picker at a time: a second request cancels the first.
        setPicker((current) => {
          current?.resolve(null);
          return {
            request,
            resolve: (result) => {
              setPicker(null);
              resolve(result);
            },
          };
        });
      }),
    [],
  );

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let disposed = false;
    let token: string | null = null;
    let grantedNow: ReadonlySet<string> = new Set();
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const decisions = new Map<string, (close: boolean) => void>();
    const windowId = hostRef.current?.windowId ?? null;
    const markReady = () => {
      if (!disposed) setPhase((current) => (current === "connecting" ? "ready" : current));
    };

    const onLoad = (granted: string[]) => () => {
      if (disposed || !token || !element.contentWindow) return;
      bridgeRef.current?.close();
      const channel = new MessageChannel();
      const bridge = new AppBridge(
        channel.port1,
        createHandlers({
          app,
          kind,
          token,
          granted: new Set(granted),
          host: hostRef.current && {
            ...hostRef.current,
            setAppState: (state: unknown) => {
              knownState.current = state;
              hostRef.current?.setAppState(state);
            },
          },
          showDialog,
          showPicker,
          markReady,
          guardClose: (enabled) => {
            if (!windowId) return;
            setCloseGuard(
              windowId,
              enabled
                ? () =>
                    new Promise<boolean>((resolve) => {
                      const requestId = randomId();
                      const timer = setTimeout(() => {
                        decisions.delete(requestId);
                        resolve(true);
                      }, CLOSE_DECISION_MS);
                      decisions.set(requestId, (close) => {
                        clearTimeout(timer);
                        decisions.delete(requestId);
                        resolve(close);
                      });
                      bridgeRef.current?.emit("lifecycle.beforeClose", { requestId });
                    })
                : null,
            );
          },
          decideClose: (requestId, close) => decisions.get(requestId)?.(close),
        }),
        () => {
          if (!disposed) setPhase("stopped");
        },
      );
      bridgeRef.current = bridge;
      element.contentWindow.postMessage({ type: INIT_TYPE, protocol: PROTOCOL }, "*", [
        channel.port2,
      ]);
      const hello: HelloMessage = {
        kind: "hello",
        protocol: PROTOCOL,
        app: {
          id: app.appId,
          version: app.version,
          name: useDesktopApps.getState().names[app.appId] ?? app.name,
        },
        instance: { id: randomId(), kind, widgetId },
        granted,
        locale: i18next.language,
        theme: themeSnapshot(useThemeStore.getState().theme),
        window: windowState(windowId),
        everyos: { version: EVERYOS_VERSION, sdk: APP_SDK_VERSION },
        state: kind === "window" ? (hostRef.current?.appState ?? null) : null,
      };
      knownState.current = hostRef.current?.appState;
      bridge.start(hello);
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = setTimeout(markReady, READY_FALLBACK_MS);
    };

    setPhase("connecting");
    let listener: (() => void) | null = null;
    void api<{ token: string; granted: string[] }>("/app-sdk/instances", {
      method: "POST",
      body: { appId: app.appId, kind, ...(widgetId ? { widgetId } : {}) },
    })
      .then((opened) => {
        if (disposed) {
          void api("/app-sdk/instances/current", {
            method: "DELETE",
            body: {},
            headers: { [INSTANCE_HEADER]: opened.token },
          }).catch(() => undefined);
          return;
        }
        token = opened.token;
        grantedNow = new Set(opened.granted);
        listener = onLoad(opened.granted);
        element.addEventListener("load", listener);
        // The source is set only once the listener is in place, so the first load is never missed.
        element.src = `${app.runtimeUrl}${entry}`;
      })
      .catch(() => {
        if (!disposed) setPhase("failed");
      });

    // Keep the app in step with the desktop.
    const unsubscribeTheme = useThemeStore.subscribe((state, previous) => {
      if (state.theme !== previous.theme)
        bridgeRef.current?.emit("theme.changed", themeSnapshot(state.theme));
    });
    const onLanguage = (locale: string) => bridgeRef.current?.emit("locale.changed", { locale });
    // Wallpapers and folder icons, for apps that manage them.
    const appearanceOf = (state: ReturnType<typeof usePreferences.getState>) =>
      JSON.stringify([
        state.appearance.wallpaper,
        state.appearance.folderIcon ?? null,
        state.desktop.desktops.map((entry) => [entry.id, entry.name, entry.wallpaper]),
      ]);
    let lastAppearance = appearanceOf(usePreferences.getState());
    const unsubscribeAppearance = usePreferences.subscribe((state) => {
      const next = appearanceOf(state);
      if (next === lastAppearance) return;
      lastAppearance = next;
      if (grantedNow.has("appearance:manage")) bridgeRef.current?.emit("appearance.changed", null);
    });
    i18next.on("languageChanged", onLanguage);
    let lastState = JSON.stringify(windowState(windowId));
    let lastVisible = windowState(windowId).visible;
    const onWindow = () => {
      const state = windowState(windowId);
      const encoded = JSON.stringify(state);
      if (encoded === lastState) return;
      lastState = encoded;
      bridgeRef.current?.emit("window.changed", state);
      if (state.visible !== lastVisible) {
        lastVisible = state.visible;
        bridgeRef.current?.emit(state.visible ? "lifecycle.resume" : "lifecycle.suspend", null);
      }
      if (state.focused) useAppBadges.getState().acknowledge(app.appId);
    };
    const unsubscribeWindows = windowManager.subscribe(onWindow);
    document.addEventListener("visibilitychange", onWindow);

    return () => {
      disposed = true;
      if (listener) element.removeEventListener("load", listener);
      if (readyTimer) clearTimeout(readyTimer);
      const bridge = bridgeRef.current;
      bridgeRef.current = null;
      unsubscribeTheme();
      unsubscribeAppearance();
      unsubscribeWindows();
      i18next.off("languageChanged", onLanguage);
      document.removeEventListener("visibilitychange", onWindow);
      if (windowId) setCloseGuard(windowId, null);
      useAppBadges.getState().clear(app.appId, windowId);
      for (const resolve of decisions.values()) resolve(true);
      // What the app saved on its way out (pagehide) is still carried out, then the instance ends.
      retireLater(() => {
        bridge?.close();
        if (token)
          void api("/app-sdk/instances/current", {
            method: "DELETE",
            body: {},
            headers: { [INSTANCE_HEADER]: token },
            keepalive: true,
          }).catch(() => undefined);
      });
    };
    // A new version (runtime URL) or a retry starts a fresh instance.
  }, [app, kind, widgetId, entry, attempt, showDialog, showPicker]);

  return (
    <div className={className ?? "relative h-full w-full overflow-hidden"}>
      <iframe
        ref={frame}
        title={name}
        sandbox={APP_FRAME_SANDBOX}
        allow="fullscreen"
        referrerPolicy="no-referrer"
        data-testid="desktop-app-frame"
        data-app-id={app.appId}
        data-phase={phase}
        className="block h-full w-full border-0 bg-transparent"
      />
      {phase === "connecting" ? (
        <div className="absolute inset-0 grid place-items-center bg-[rgb(var(--everyos-surface)/0.6)]">
          <Spinner
            className="size-6 text-fg-subtle"
            label={t("desktopApps.frame.opening", { name })}
          />
        </div>
      ) : null}
      {phase === "failed" || phase === "stopped" ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[rgb(var(--everyos-surface)/0.85)] p-6 text-center"
        >
          <AlertTriangle className="size-8 text-warning" aria-hidden />
          <p className="max-w-sm text-sm text-fg-muted">
            {phase === "failed"
              ? t("desktopApps.frame.failed", { name })
              : t("desktopApps.frame.stopped", { name })}
          </p>
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            {t("window.reload")}
          </Button>
        </div>
      ) : null}
      {dialogs[0] ? <AppDialog dialog={dialogs[0]} appName={name} /> : null}
      {picker ? (
        <FilePicker request={picker.request} appName={name} onDone={picker.resolve} />
      ) : null}
    </div>
  );
}
