import {
  BRIDGE_ERRORS,
  type DbConnection,
  type DirectoryEntry,
  type FileHandle,
  type WindowState,
} from "@everyos/app-sdk/protocol";
import { isErrorCode, type DesktopAppInstallationView } from "@everyos/shared";
import { effectiveRect } from "@everyos/window-manager";
import { i18next } from "../../app/i18n.ts";
import { api, ApiRequestError } from "../../lib/api.ts";
import { copyText } from "../../lib/clipboard.ts";
import type { AppHost } from "../apps/app-context.ts";
import { desktop } from "../state/controller.ts";
import { wm } from "../state/window-store.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import type { PendingDialog } from "./app-dialog.tsx";
import type { PickerRequest, PickerResult } from "./file-picker.tsx";
import { useAppBadges } from "./badges.ts";
import { BridgeRefusal, type Handlers } from "./bridge.ts";
import { desktopAppWindowId } from "./store.ts";
import { themeSnapshot } from "./theme-snapshot.ts";

export const INSTANCE_HEADER = "x-everyos-app-instance";

type DialogRequest =
  | Omit<Extract<PendingDialog, { kind: "alert" }>, "id" | "resolve">
  | Omit<Extract<PendingDialog, { kind: "confirm" }>, "id" | "resolve">
  | Omit<Extract<PendingDialog, { kind: "prompt" }>, "id" | "resolve">;

export interface InstanceContext {
  app: DesktopAppInstallationView;
  kind: "window" | "widget";
  token: string;
  granted: ReadonlySet<string>;
  /** The window the frame lives in (null for widgets). */
  host: AppHost | null;
  showDialog(request: DialogRequest): Promise<boolean | string | null>;
  showPicker(request: PickerRequest): Promise<PickerResult | null>;
  markReady(): void;
  guardClose(enabled: boolean): void;
  decideClose(requestId: string, close: boolean): void;
}

/** The current state of a window frame, as the app sees it. */
export function windowState(windowId: string | null): WindowState {
  const state = windowId ? wm().windows[windowId] : undefined;
  const pageVisible = document.visibilityState === "visible";
  if (!state)
    return {
      visible: pageVisible,
      focused: document.hasFocus(),
      maximized: true,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  const rect = effectiveRect(state, wm().viewport);
  return {
    visible: pageVisible && !state.minimized && state.desktopId === wm().activeDesktopId,
    focused: wm().focusedId === state.id,
    maximized: state.layout === "maximized" || state.layout === "fullscreen",
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

const refuse = (capability: string) =>
  new BridgeRefusal(BRIDGE_ERRORS.permission, `The app may not use ${capability}`, {
    capability,
  });

/** What one app instance may ask the desktop for, implemented for that instance. */
export function createHandlers(context: InstanceContext): Handlers {
  const { app, host, token } = context;
  const windowId = host?.windowId ?? null;
  const sdk = <T>(
    path: string,
    init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
  ) => api<T>(`/app-sdk${path}`, { ...init, headers: { [INSTANCE_HEADER]: token } });
  const managed = () => (windowId && wm().windows[windowId] ? windowId : null);
  /**
   * For a database write: false when there is nothing to confirm (a read, or a connection that
   * only reads, which the server refuses), true once the person confirmed; refuses otherwise.
   */
  const confirmWrite = async (input: unknown): Promise<boolean> => {
    const query = input as { write?: unknown; sql?: unknown; connection?: unknown } | null;
    if (!query || query.write !== true || typeof query.sql !== "string") return false;
    const { connections } = (
      await sdk<{ result: { connections: DbConnection[] } }>("/host/db.connections", {
        method: "POST",
        body: { input: null },
      })
    ).result;
    const connection = connections.find((entry) => entry.id === query.connection);
    if (!connection || connection.access !== "write") return false;
    if (context.kind !== "window")
      throw new BridgeRefusal(BRIDGE_ERRORS.permission, "Widgets cannot change databases");
    const confirmed = await context.showDialog({
      kind: "confirm",
      title: i18next.t("desktopApps.dialog.writeTitle", { connection: connection.name }),
      message: i18next.t("desktopApps.dialog.writeBody", {
        app: app.name,
        database: `${connection.database} · ${connection.host}`,
      }),
      confirm: i18next.t("desktopApps.dialog.writeConfirm"),
      destructive: true,
      host: { code: query.sql.slice(0, 20_000) },
    });
    if (confirmed !== true)
      throw new BridgeRefusal(BRIDGE_ERRORS.cancelled, "The person did not confirm the change");
    return true;
  };
  const file = (id: string) => `/files/${encodeURIComponent(id)}`;
  /** Binary reads skip the JSON helper; errors still arrive as API errors. */
  const readBytes = async (path: string): Promise<{ data: ArrayBuffer; eof: boolean }> => {
    const response = await fetch(`/api/app-sdk${path}`, {
      credentials: "same-origin",
      headers: { [INSTANCE_HEADER]: token },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: string; details?: unknown };
      } | null;
      const code = isErrorCode(body?.error?.code) ? body.error.code : "UNKNOWN";
      throw new ApiRequestError(
        response.status,
        code,
        body?.error?.message ?? "",
        body?.error?.details,
      );
    }
    return {
      data: await response.arrayBuffer(),
      eof: response.headers.get("x-everyos-eof") === "1",
    };
  };

  const shared: Handlers = {
    "storage.get": async ({ key }) =>
      (
        await sdk<{ entry: { value: unknown } | null }>("/storage/get", {
          method: "POST",
          body: { key },
        })
      ).entry,
    "storage.set": async ({ key, value }) => {
      await sdk("/storage/set", { method: "POST", body: { key, value } });
      return null;
    },
    "storage.delete": async ({ key }) => {
      await sdk("/storage/delete", { method: "POST", body: { key } });
      return null;
    },
    "storage.keys": async ({ prefix }) =>
      (
        await sdk<{ keys: Array<{ key: string; size: number }> }>("/storage/keys", {
          method: "POST",
          body: { prefix },
        })
      ).keys,
    "storage.usage": () => sdk<{ used: number; quota: number; keys: number }>("/storage/usage"),
    "storage.clear": async () => {
      await sdk("/storage/clear", { method: "POST", body: {} });
      return null;
    },
    "notifications.send": async ({ title, body, level, tag }) => {
      await sdk("/notifications", { method: "POST", body: { title, body, level, tag } });
      return null;
    },
    "host.call": async ({ operation, input }) => {
      // An app changes a database only after the person confirms the statement here.
      const confirmed = operation === "db.query" && (await confirmWrite(input));
      return (
        await sdk<{ result: unknown }>(`/host/${operation}`, {
          method: "POST",
          body: { input, ...(confirmed ? { confirmed: true } : {}) },
        })
      ).result;
    },
    "theme.get": () => themeSnapshot(useThemeStore.getState().theme),
    "locale.get": () => ({ locale: i18next.language }),
    "lifecycle.ready": () => {
      context.markReady();
      return null;
    },
    "clipboard.writeText": async ({ text }) => {
      if (!context.granted.has("clipboard:write")) throw refuse("clipboard:write");
      if (!(await copyText(text)))
        throw new BridgeRefusal(BRIDGE_ERRORS.cancelled, "The browser did not allow copying");
      return null;
    },
    "window.open": ({ state }) => {
      const id = desktopAppWindowId(app.appId);
      if (app.window.instances === "multiple") desktop.openWindow(id, state);
      else desktop.openApp(id, { appState: state });
      return null;
    },
  };
  if (context.kind === "widget") return shared;

  return {
    ...shared,
    "window.setTitle": ({ title }) => {
      host?.setTitle(title);
      return null;
    },
    "window.setBadge": ({ count }) => {
      useAppBadges.getState().setBadge(app.appId, windowId, count);
      return null;
    },
    "window.focus": () => {
      const id = managed();
      if (id) wm().focus(id);
      return null;
    },
    "window.requestAttention": () => {
      useAppBadges.getState().requestAttention(app.appId, windowId);
      return null;
    },
    "window.minimize": () => {
      const id = managed();
      if (id) wm().minimize(id);
      return null;
    },
    "window.maximize": ({ maximized }) => {
      const id = managed();
      const current = id ? wm().windows[id] : undefined;
      if (id && current && (current.layout === "maximized") !== maximized) wm().toggleMaximize(id);
      return null;
    },
    "window.resize": ({ width, height }) => {
      const id = managed();
      const current = id ? wm().windows[id] : undefined;
      if (id && current)
        wm().setBounds(id, {
          ...current.bounds,
          width: Math.max(width, app.window.minWidth),
          height: Math.max(height, app.window.minHeight),
        });
      return windowState(windowId);
    },
    "window.close": () => {
      host?.close();
      return null;
    },
    "window.getState": () => windowState(windowId),
    "window.setState": ({ state }) => {
      host?.setAppState(state);
      return null;
    },
    "dialog.alert": async ({ title, message }) => {
      await context.showDialog({ kind: "alert", title, message });
      return null;
    },
    "dialog.confirm": async ({ title, message, confirm, destructive }) =>
      (await context.showDialog({ kind: "confirm", title, message, confirm, destructive })) ===
      true,
    "dialog.prompt": async ({ title, message, value, placeholder }) => {
      const answer = await context.showDialog({
        kind: "prompt",
        title,
        message,
        value,
        placeholder,
      });
      return typeof answer === "string" ? answer : null;
    },
    "files.open": async ({ accept, multiple, directory, persist, write }) => {
      const picked = await context.showPicker({ mode: "open", accept, multiple, directory, write });
      if (!picked || picked.mode !== "open") return [];
      return (
        await sdk<{ handles: FileHandle[] }>("/files/grants", {
          method: "POST",
          body: { items: picked.items, write, persist },
        })
      ).handles;
    },
    "files.save": async ({ suggestedName, accept, persist }) => {
      const picked = await context.showPicker({ mode: "save", accept, suggestedName });
      if (!picked || picked.mode !== "save") return null;
      return (
        await sdk<{ handle: FileHandle }>("/files/grants/save", {
          method: "POST",
          body: { root: picked.root, path: picked.path, name: picked.name, persist },
        })
      ).handle;
    },
    "files.read": ({ handle, offset, length }) =>
      readBytes(`${file(handle)}/read?offset=${offset}&length=${length}`),
    "files.write": ({ handle, offset, data, done }) =>
      api<{ size: number }>(`/app-sdk${file(handle)}/write?offset=${offset}&done=${done}`, {
        method: "POST",
        raw: { body: data, contentType: "application/octet-stream" },
        headers: { [INSTANCE_HEADER]: token },
      }),
    "files.list": async ({ handle, path }) =>
      (
        await sdk<{ entries: DirectoryEntry[] }>(
          `${file(handle)}/list?path=${encodeURIComponent(path)}`,
        )
      ).entries,
    "files.child": async ({ handle, path, create }) =>
      (
        await sdk<{ handle: FileHandle }>(`${file(handle)}/child`, {
          method: "POST",
          body: { path, create },
        })
      ).handle,
    "files.url": ({ handle }) =>
      sdk<{ url: string; expiresAt: number }>(`${file(handle)}/url`, { method: "POST", body: {} }),
    "files.handles": async () => (await sdk<{ handles: FileHandle[] }>("/files")).handles,
    "files.revoke": async ({ handle }) => {
      await sdk(file(handle), { method: "DELETE", body: {} });
      return null;
    },
    "lifecycle.guardClose": ({ enabled }) => {
      context.guardClose(enabled);
      return null;
    },
    "lifecycle.closeDecision": ({ requestId, close }) => {
      context.decideClose(requestId, close);
      return null;
    },
  };
}
