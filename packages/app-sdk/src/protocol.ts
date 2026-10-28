/*
 * The EveryOS app bridge, protocol 1 (docs/app-sdk/architecture.md). The desktop posts one
 * `everyos:init` message with a MessagePort into the app's sandboxed frame; everything after that
 * travels over the port. This module is the contract both sides compile against; the desktop also
 * validates every incoming message at run time, because an app may send anything.
 */

import type { HostOperation } from "./host-operations.ts";

export const PROTOCOL = 1;
/** This SDK's version (apps declare the range they need in `manifest.sdk`). */
export const SDK_VERSION = "1.0.1";
export const INIT_TYPE = "everyos:init";

/** Largest message either side accepts (file data travels in chunks below this). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Largest file chunk read or written in one call. */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** Largest value stored under one storage key (JSON-encoded). */
export const MAX_STORAGE_VALUE_BYTES = 256 * 1024;

export interface InitMessage {
  type: typeof INIT_TYPE;
  protocol: typeof PROTOCOL;
}

/* ------------------------------------------------------------------ shared values */

export type ColorScheme = "light" | "dark";

/** What an app needs to look like the desktop around it. */
export interface ThemeSnapshot {
  scheme: ColorScheme;
  /** CSS custom properties (`--everyos-*`), values as the desktop uses them. */
  tokens: Record<string, string>;
  accent: string;
  fontFamily: string;
  reducedMotion: boolean;
  /** Reduced transparency / high contrast rendering requested by the user. */
  reducedTransparency: boolean;
  density: "comfortable" | "compact";
}

export interface WindowState {
  /** The window is shown (not minimized, on the current virtual desktop, page visible). */
  visible: boolean;
  focused: boolean;
  maximized: boolean;
  width: number;
  height: number;
}

export interface HelloMessage {
  kind: "hello";
  protocol: typeof PROTOCOL;
  app: { id: string; version: string; name: string };
  /** One window or widget frame of the app. */
  instance: { id: string; kind: "window" | "widget"; widgetId: string | null };
  /** Capabilities the server granted this installation (the server still checks every call). */
  granted: string[];
  locale: string;
  theme: ThemeSnapshot;
  window: WindowState;
  everyos: { version: string; sdk: string };
  /** Restored per-window state the app saved with `window.setState` (null for a new window). */
  state: unknown;
}

export interface FileHandle {
  /** Opaque id valid for this app and user until revoked (or the window closes, if temporary). */
  id: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  /** MIME type guessed from the name. */
  type: string | null;
  writable: boolean;
  persistent: boolean;
}

export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: number;
}

export type NotificationLevel = "info" | "success" | "warning" | "critical";

/** A wallpaper as EveryOS describes one (colors are `#rrggbb`). */
export type WallpaperChoice =
  | { kind: "preset"; id: string }
  | { kind: "gradient"; from: string; to: string; angle: number }
  | { kind: "solid"; color: string }
  | { kind: "image"; wallpaperId: string; fit: "cover" | "contain" };

export type FolderIconChoice =
  { kind: "preset"; id: string } | { kind: "uploaded"; iconId: string };

/** Images the person uploaded: wallpapers, or folder icons. */
export type AppearanceImageKind = "wallpaper" | "folder-icon";

export interface AppearanceImage {
  id: string;
  type: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  width: number;
  height: number;
  createdAt: number;
}

/** The person's appearance, as an app holding appearance:manage sees it. */
export interface AppearanceState {
  /** The wallpaper of every desktop without its own (null: EveryOS's default). */
  wallpaper: WallpaperChoice | null;
  desktops: Array<{ id: string; name: string; wallpaper: WallpaperChoice | null; active: boolean }>;
  wallpaperPresets: Array<{ id: string; name: string; scheme: "dark" | "light" }>;
  wallpapers: AppearanceImage[];
  folderIcon: FolderIconChoice | null;
  folderIconPresets: Array<{ id: string; name: string }>;
  folderIcons: AppearanceImage[];
  limits: {
    wallpapers: number;
    wallpaperBytes: number;
    folderIconBytes: number;
    folderIconEdge: number;
  };
}

/** What `appearance.image` draws: an uploaded image, or a preset's preview. */
export type AppearanceImageSource =
  | { kind: AppearanceImageKind; id: string }
  | { kind: "wallpaper-preset" | "folder-icon-preset"; id: string };

/* ------------------------------------------------------------------ methods */

/** Every request an app can make: params and result per method. */
export interface Methods {
  "window.setTitle": { params: { title: string }; result: null };
  "window.setBadge": { params: { count: number | null }; result: null };
  "window.focus": { params: null; result: null };
  "window.requestAttention": { params: null; result: null };
  "window.minimize": { params: null; result: null };
  "window.maximize": { params: { maximized: boolean }; result: null };
  "window.resize": { params: { width: number; height: number }; result: WindowState };
  "window.close": { params: null; result: null };
  "window.getState": { params: null; result: WindowState };
  /** Per-window state restored with the window after a reload (≤ 64 KiB JSON). */
  "window.setState": { params: { state: unknown }; result: null };
  /** Opens a window of the app (another one for multi-instance apps), with initial state. */
  "window.open": { params: { state: unknown }; result: null };

  "storage.get": { params: { key: string }; result: { value: unknown } | null };
  "storage.set": { params: { key: string; value: unknown }; result: null };
  "storage.delete": { params: { key: string }; result: null };
  "storage.keys": { params: { prefix: string }; result: Array<{ key: string; size: number }> };
  "storage.usage": { params: null; result: { used: number; quota: number; keys: number } };
  "storage.clear": { params: null; result: null };

  /** `write` asks for read-write access (needs files:save), e.g. an editor's workspace folder. */
  "files.open": {
    params: {
      accept: string[];
      multiple: boolean;
      directory: boolean;
      persist: boolean;
      write: boolean;
    };
    result: FileHandle[];
  };
  "files.save": {
    params: { suggestedName: string; accept: string[]; persist: boolean };
    result: FileHandle | null;
  };
  "files.read": {
    params: { handle: string; offset: number; length: number };
    result: { data: ArrayBuffer; eof: boolean };
  };
  /**
   * Replaces a file's content in sequential chunks: offset 0 starts a new write, `done` commits it
   * (the file changes atomically, never half-written).
   */
  "files.write": {
    params: { handle: string; offset: number; data: ArrayBuffer; done: boolean };
    result: { size: number };
  };
  "files.list": { params: { handle: string; path: string }; result: DirectoryEntry[] };
  "files.child": {
    params: { handle: string; path: string; create: "file" | "directory" | null };
    result: FileHandle;
  };
  /** A short-lived URL for media elements (`<audio>`, `<video>`, `<img>`), read-only. */
  "files.url": { params: { handle: string }; result: { url: string; expiresAt: number } };
  "files.handles": { params: null; result: FileHandle[] };
  "files.revoke": { params: { handle: string }; result: null };

  "notifications.send": {
    params: { title: string; body: string; level: NotificationLevel; tag: string | null };
    result: null;
  };

  "dialog.alert": { params: { title: string; message: string }; result: null };
  "dialog.confirm": {
    params: { title: string; message: string; confirm: string | null; destructive: boolean };
    result: boolean;
  };
  "dialog.prompt": {
    params: { title: string; message: string; value: string; placeholder: string | null };
    result: string | null;
  };

  "clipboard.writeText": { params: { text: string }; result: null };

  "appearance.get": { params: null; result: AppearanceState };
  /** An image, scaled to fit `maxEdge` pixels (PNG, JPEG or WebP bytes). */
  "appearance.image": {
    params: { source: AppearanceImageSource; maxEdge: number };
    result: { data: ArrayBuffer; type: string };
  };
  /** Uploads a JPEG, PNG or WebP image the person made in the app. */
  "appearance.upload": {
    params: { kind: AppearanceImageKind; data: ArrayBuffer; type: AppearanceImage["type"] };
    result: AppearanceImage;
  };
  "appearance.deleteImage": { params: { kind: AppearanceImageKind; id: string }; result: null };
  /** Sets the wallpaper of one desktop, or (`desktopId: null`) the default of all. */
  "appearance.setWallpaper": {
    params: { desktopId: string | null; wallpaper: WallpaperChoice | null };
    result: null;
  };
  "appearance.setFolderIcon": { params: { icon: FolderIconChoice | null }; result: null };

  "theme.get": { params: null; result: ThemeSnapshot };
  "locale.get": { params: null; result: { locale: string } };

  /** The app finished loading (the desktop hides its loading state). */
  "lifecycle.ready": { params: null; result: null };
  /** Whether closing the window should first ask the app (`lifecycle.beforeClose` event). */
  "lifecycle.guardClose": { params: { enabled: boolean }; result: null };
  /** Answer to a `lifecycle.beforeClose` event. */
  "lifecycle.closeDecision": { params: { requestId: string; close: boolean }; result: null };

  /** Server-backed host data, each behind its capability. */
  "host.call": {
    params: { operation: HostOperation; input: unknown };
    result: unknown;
  };
}

export * from "./host-operations.ts";

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

/* ------------------------------------------------------------------ events */

export interface Events {
  "theme.changed": ThemeSnapshot;
  "locale.changed": { locale: string };
  "window.changed": WindowState;
  /** The running window was opened again with new state (from a widget, for example). */
  "window.opened": { state: unknown };
  /** The page or window went into the background (suspend) or came back (resume). */
  "lifecycle.suspend": null;
  "lifecycle.resume": null;
  /** Someone wants to close the window; answer with `lifecycle.closeDecision`. */
  "lifecycle.beforeClose": { requestId: string };
  "permissions.changed": { granted: string[] };
  /** A newer version was installed; the window reloads into it when the app is ready. */
  "app.updated": { version: string };
  /** Files handles were revoked from outside (the user or an administrator). */
  "files.revoked": { handles: string[] };
  /** The person's wallpapers or folder icons changed (in Settings or another app). */
  "appearance.changed": null;
}
export type EventName = keyof Events;

/* ------------------------------------------------------------------ envelopes */

export interface RequestMessage<M extends Method = Method> {
  kind: "request";
  id: number;
  method: M;
  params: Params<M>;
}

export interface ErrorPayload {
  /** `EVERYOS_*` codes for bridge problems, API error codes for server answers. */
  code: string;
  message: string;
  details?: unknown;
}

export type ResponseMessage =
  | { kind: "response"; id: number; ok: true; result: unknown }
  | { kind: "response"; id: number; ok: false; error: ErrorPayload };

export interface EventMessage<E extends EventName = EventName> {
  kind: "event";
  event: E;
  data: Events[E];
}

export type HostMessage = HelloMessage | ResponseMessage | EventMessage;

/** Bridge-level error codes (the server's API error codes pass through unchanged). */
export const BRIDGE_ERRORS = {
  invalid: "EVERYOS_INVALID_REQUEST",
  unknownMethod: "EVERYOS_UNKNOWN_METHOD",
  permission: "EVERYOS_PERMISSION_DENIED",
  rateLimited: "EVERYOS_RATE_LIMITED",
  tooLarge: "EVERYOS_TOO_LARGE",
  timeout: "EVERYOS_TIMEOUT",
  closed: "EVERYOS_CLOSED",
  cancelled: "EVERYOS_CANCELLED",
} as const;
