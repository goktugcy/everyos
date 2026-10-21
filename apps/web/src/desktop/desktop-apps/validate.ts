import {
  HOST_OPERATIONS,
  MAX_CHUNK_BYTES,
  MAX_STORAGE_VALUE_BYTES,
  type Method,
} from "@everyos/app-sdk/protocol";
import {
  FOLDER_ICON_PRESET_IDS,
  MAX_WALLPAPER_BYTES,
  WALLPAPER_MIME_TYPES,
  WALLPAPER_PRESET_IDS,
} from "@everyos/shared";

/*
 * Run-time checks of what an app sends. The app is untrusted: every request is checked against the
 * exact shape its method takes (no extra keys, bounded strings, numbers and sizes, plain JSON only)
 * before anything acts on it. The browser bundle stays zod-free (AGENTS.md).
 */

type Check = (value: unknown) => boolean;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** JSON-compatible data only (no Map, Date, typed arrays…), nested at most 64 levels. */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

const text =
  (max: number, min = 0): Check =>
  (value) =>
    typeof value === "string" && value.length >= min && value.length <= max;
const plainText =
  (max: number, min = 0): Check =>
  (value) =>
    text(max, min)(value) && ![...(value as string)].some((char) => char.charCodeAt(0) < 0x20);
const int =
  (min: number, max: number): Check =>
  (value) =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const bool: Check = (value) => typeof value === "boolean";
const none: Check = (value) => value === null || value === undefined;
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const oneOf =
  (...values: readonly unknown[]): Check =>
  (value) =>
    values.includes(value);
const list =
  (check: Check, max: number): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(check);
const json =
  (maxBytes: number): Check =>
  (value) => {
    if (!isJsonValue(value)) return false;
    const encoded = JSON.stringify(value);
    return encoded.length <= maxBytes;
  };
const buffer =
  (max: number): Check =>
  (value) =>
    value instanceof ArrayBuffer && value.byteLength <= max;
const shape =
  (fields: Record<string, Check>): Check =>
  (value) =>
    isRecord(value) &&
    Object.keys(value).every((key) => key in fields) &&
    Object.entries(fields).every(([key, check]) => check(value[key]));

const handle = text(64, 1);
const storageKey = plainText(256, 1);
/** A relative path inside a granted folder: no absolute paths or `..`. */
const relativePath: Check = (value) =>
  plainText(1024)(value) &&
  !(value as string).startsWith("/") &&
  !(value as string).split("/").some((part) => part === "..");
const fileName: Check = (value) =>
  plainText(255, 1)(value) && !/[/\\]/.test(value as string) && value !== "." && value !== "..";
const accept = list(plainText(100), 32);
const imageId: Check = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const hexColor: Check = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const imageKind = oneOf("wallpaper", "folder-icon");
const wallpaperChoice: Check = (value) =>
  shape({ kind: oneOf("preset"), id: oneOf(...WALLPAPER_PRESET_IDS) })(value) ||
  shape({ kind: oneOf("gradient"), from: hexColor, to: hexColor, angle: int(0, 360) })(value) ||
  shape({ kind: oneOf("solid"), color: hexColor })(value) ||
  shape({ kind: oneOf("image"), wallpaperId: imageId, fit: oneOf("cover", "contain") })(value);
const folderIconChoice: Check = (value) =>
  shape({ kind: oneOf("preset"), id: oneOf(...FOLDER_ICON_PRESET_IDS) })(value) ||
  shape({ kind: oneOf("uploaded"), iconId: imageId })(value);

export const VALIDATORS: Readonly<Record<Method, Check>> = {
  "window.setTitle": shape({ title: plainText(120) }),
  "window.setBadge": shape({ count: nullable(int(0, 99_999)) }),
  "window.focus": none,
  "window.requestAttention": none,
  "window.minimize": none,
  "window.maximize": shape({ maximized: bool }),
  "window.resize": shape({ width: int(160, 8192), height: int(160, 8192) }),
  "window.close": none,
  "window.getState": none,
  "window.setState": shape({ state: json(64 * 1024) }),
  "window.open": shape({ state: json(64 * 1024) }),

  "storage.get": shape({ key: storageKey }),
  "storage.set": shape({ key: storageKey, value: json(MAX_STORAGE_VALUE_BYTES) }),
  "storage.delete": shape({ key: storageKey }),
  "storage.keys": shape({ prefix: plainText(256) }),
  "storage.usage": none,
  "storage.clear": none,

  "files.open": shape({ accept, multiple: bool, directory: bool, persist: bool, write: bool }),
  "files.save": shape({ suggestedName: fileName, accept, persist: bool }),
  "files.read": shape({
    handle,
    offset: int(0, Number.MAX_SAFE_INTEGER),
    length: int(1, MAX_CHUNK_BYTES),
  }),
  "files.write": shape({
    handle,
    offset: int(0, Number.MAX_SAFE_INTEGER),
    data: buffer(MAX_CHUNK_BYTES),
    done: bool,
  }),
  "files.list": shape({ handle, path: relativePath }),
  "files.child": shape({
    handle,
    path: (value) => relativePath(value) && (value as string).length > 0,
    create: nullable(oneOf("file", "directory")),
  }),
  "files.url": shape({ handle }),
  "files.handles": none,
  "files.revoke": shape({ handle }),

  "notifications.send": shape({
    title: plainText(120, 1),
    body: text(200),
    level: oneOf("info", "success", "warning", "critical"),
    tag: nullable(plainText(64, 1)),
  }),

  "dialog.alert": shape({ title: plainText(200, 1), message: text(2000) }),
  "dialog.confirm": shape({
    title: plainText(200, 1),
    message: text(2000),
    confirm: nullable(plainText(40, 1)),
    destructive: bool,
  }),
  "dialog.prompt": shape({
    title: plainText(200, 1),
    message: text(2000),
    value: text(1000),
    placeholder: nullable(plainText(200)),
  }),

  "clipboard.writeText": shape({ text: text(1_000_000) }),

  "appearance.get": none,
  "appearance.image": shape({
    source: shape({
      kind: oneOf("wallpaper", "folder-icon", "wallpaper-preset", "folder-icon-preset"),
      id: imageId,
    }),
    maxEdge: int(16, 4096),
  }),
  "appearance.upload": shape({
    kind: imageKind,
    data: buffer(MAX_WALLPAPER_BYTES),
    type: oneOf(...WALLPAPER_MIME_TYPES),
  }),
  "appearance.deleteImage": shape({ kind: imageKind, id: imageId }),
  "appearance.setWallpaper": shape({
    desktopId: nullable(imageId),
    wallpaper: nullable(wallpaperChoice),
  }),
  "appearance.setFolderIcon": shape({ icon: nullable(folderIconChoice) }),
  "theme.get": none,
  "locale.get": none,

  "lifecycle.ready": none,
  "lifecycle.guardClose": shape({ enabled: bool }),
  "lifecycle.closeDecision": shape({ requestId: plainText(64, 1), close: bool }),

  "host.call": shape({ operation: oneOf(...HOST_OPERATIONS), input: json(256 * 1024) }),
};
