import {
  BRIDGE_ERRORS,
  type AppearanceImage,
  type AppearanceImageKind,
  type AppearanceState,
} from "@everyos/app-sdk/protocol";
import {
  FOLDER_ICON_PRESET_IDS,
  MAX_FOLDER_ICON_BYTES,
  MAX_FOLDER_ICON_EDGE,
  MAX_WALLPAPER_BYTES,
  MAX_WALLPAPERS_PER_USER,
  WALLPAPER_PRESET_IDS,
  type FolderIconPresetId,
  type FolderIconSpec,
  type WallpaperInfo,
  type WallpaperPresetId,
  type WallpaperSpec,
} from "@everyos/shared";
import { WALLPAPER_PRESETS } from "@everyos/theme";
import { i18next } from "../../app/i18n.ts";
import { setDesktopWallpaper } from "../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { wm } from "../state/window-store.ts";
import { BridgeRefusal, type Handlers } from "./bridge.ts";

/*
 * Wallpapers and folder icons for apps holding appearance:manage (Wallpaper Studio, Icon Studio).
 * Images go through `/api/app-sdk/appearance`, where the server checks the grant on every call;
 * choosing one is the person's own preference, applied here like Settings does.
 */

const toImage = (info: WallpaperInfo): AppearanceImage => ({
  id: info.id,
  type: info.mime,
  size: info.size,
  width: info.width,
  height: info.height,
  createdAt: info.createdAt,
});

const FOLDER_COLORS: Partial<Record<FolderIconPresetId, string>> = {
  amber: "#f59e0b",
  green: "#22c55e",
  violet: "#a78bfa",
};
/** lucide's folder outline (the glyph Files draws). */
const FOLDER_PATH =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";

function accentColor(): string {
  const triplet = getComputedStyle(document.documentElement)
    .getPropertyValue("--everyos-accent")
    .trim();
  return triplet ? `rgb(${triplet.split(/\s+/).join(",")})` : "#6366f1";
}

/** The folder preset as Files draws it, as SVG text (for a preview image). */
function folderSvg(id: FolderIconPresetId): string {
  const color = FOLDER_COLORS[id] ?? accentColor();
  if (id === "soft")
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256"><path d="M7 16a5 5 0 0 1 5-5h13l7 7h20a5 5 0 0 1 5 5v27H7z" fill="${color}" opacity=".7"/><path d="M7 27a5 5 0 0 1 5-5h40a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5z" fill="${color}"/><path d="M12 25h40" stroke="white" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/></svg>`;
  const outline = id === "outline";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="256" height="256" fill="${outline ? "none" : color}" fill-opacity="${id === "classic" ? 0.32 : 0.6}" stroke="${color}" stroke-width="${outline ? 1.6 : 1.15}" stroke-linecap="round" stroke-linejoin="round"><path d="${FOLDER_PATH}"/></svg>`;
}

async function canvasBytes(
  canvas: HTMLCanvasElement,
  type: "image/png" | "image/jpeg",
): Promise<{ data: ArrayBuffer; type: string }> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  if (!blob) throw new BridgeRefusal(BRIDGE_ERRORS.invalid, "The image could not be drawn");
  return { data: await blob.arrayBuffer(), type };
}

/** An image scaled down to fit `maxEdge` (never up); small ones travel as they are. */
async function fit(blob: Blob, maxEdge: number): Promise<{ data: ArrayBuffer; type: string }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) {
    bitmap.close();
    return { data: await blob.arrayBuffer(), type: blob.type || "image/png" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasBytes(canvas, blob.type === "image/jpeg" ? "image/jpeg" : "image/png");
}

/** A preview of a preset wallpaper: its bundled picture, or its colors drawn as on the desktop. */
async function presetPreview(id: WallpaperPresetId, maxEdge: number) {
  const preset = WALLPAPER_PRESETS[id];
  if (preset.image) {
    const response = await fetch(preset.image, { credentials: "same-origin" });
    if (response.ok) return fit(await response.blob(), maxEdge);
  }
  const canvas = document.createElement("canvas");
  canvas.width = maxEdge;
  canvas.height = Math.round((maxEdge * 10) / 16);
  const context = canvas.getContext("2d")!;
  context.fillStyle = preset.colors.base;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const glow = (x: number, y: number, radius: number, color: string) => {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "transparent");
    context.globalAlpha = preset.glow;
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = 1;
  };
  const { width: w, height: h } = canvas;
  glow(w * 0.15, h * 0.1, w * 0.55, preset.colors.a);
  glow(w * 0.9, h * 0.25, w * 0.5, preset.colors.b);
  glow(w * 0.5, h * 0.6, w * 0.35, preset.colors.c);
  return canvasBytes(canvas, "image/png");
}

async function folderPreview(id: FolderIconPresetId, maxEdge: number) {
  const url = URL.createObjectURL(new Blob([folderSvg(id)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(maxEdge, 512);
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasBytes(canvas, "image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The appearance methods of a window instance (`sdk` calls `/api/app-sdk` as that instance). */
export function appearanceHandlers(
  granted: ReadonlySet<string>,
  sdk: <T>(
    path: string,
    init?: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      raw?: { body: Blob | ArrayBuffer; contentType: string };
    },
  ) => Promise<T>,
  fetchImage: (path: string) => Promise<Blob>,
): Partial<Handlers> {
  const check = () => {
    if (!granted.has("appearance:manage"))
      throw new BridgeRefusal(BRIDGE_ERRORS.permission, "The app may not use appearance:manage", {
        capability: "appearance:manage",
      });
  };
  const images = () =>
    sdk<{ wallpapers: WallpaperInfo[]; folderIcons: WallpaperInfo[] }>("/appearance/images");
  const exists = async (kind: AppearanceImageKind, id: string) => {
    const list = await images();
    return (kind === "wallpaper" ? list.wallpapers : list.folderIcons).some(
      (image) => image.id === id,
    );
  };
  const missing = () => new BridgeRefusal(BRIDGE_ERRORS.invalid, "No such image");

  return {
    "appearance.get": async (): Promise<AppearanceState> => {
      check();
      const { appearance, desktop } = usePreferences.getState();
      const list = await images();
      const active = wm().activeDesktopId;
      return {
        wallpaper: appearance.wallpaper,
        desktops: desktop.desktops.map((entry) => ({
          id: entry.id,
          name: entry.name,
          wallpaper: entry.wallpaper,
          active: entry.id === active,
        })),
        wallpaperPresets: WALLPAPER_PRESET_IDS.map((id) => ({
          id,
          name: i18next.t(`wallpapers.${id}`),
          scheme: WALLPAPER_PRESETS[id].scheme,
        })),
        wallpapers: list.wallpapers.map(toImage),
        folderIcon: appearance.folderIcon ?? null,
        folderIconPresets: FOLDER_ICON_PRESET_IDS.map((id) => ({
          id,
          name: i18next.t(`folderIcons.presets.${id}`),
        })),
        folderIcons: list.folderIcons.map(toImage),
        limits: {
          wallpapers: MAX_WALLPAPERS_PER_USER,
          wallpaperBytes: MAX_WALLPAPER_BYTES,
          folderIconBytes: MAX_FOLDER_ICON_BYTES,
          folderIconEdge: MAX_FOLDER_ICON_EDGE,
        },
      };
    },
    "appearance.image": async ({ source, maxEdge }) => {
      check();
      if (source.kind === "wallpaper-preset") {
        if (!(WALLPAPER_PRESET_IDS as readonly string[]).includes(source.id)) throw missing();
        return presetPreview(source.id as WallpaperPresetId, maxEdge);
      }
      if (source.kind === "folder-icon-preset") {
        if (!(FOLDER_ICON_PRESET_IDS as readonly string[]).includes(source.id)) throw missing();
        return folderPreview(source.id as FolderIconPresetId, maxEdge);
      }
      return fit(
        await fetchImage(`/appearance/images/${source.kind}/${encodeURIComponent(source.id)}`),
        maxEdge,
      );
    },
    "appearance.upload": async ({ kind, data, type }) => {
      check();
      return toImage(
        await sdk<WallpaperInfo>(`/appearance/images/${kind}`, {
          method: "POST",
          raw: { body: data, contentType: type },
        }),
      );
    },
    "appearance.deleteImage": async ({ kind, id }) => {
      check();
      await sdk(`/appearance/images/${kind}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: {},
      });
      return null;
    },
    "appearance.setWallpaper": async ({ desktopId, wallpaper }) => {
      check();
      if (wallpaper?.kind === "image" && !(await exists("wallpaper", wallpaper.wallpaperId)))
        throw missing();
      const spec = wallpaper as WallpaperSpec | null;
      if (desktopId === null)
        updatePreference("appearance", (current) => ({ ...current, wallpaper: spec }));
      else {
        if (!usePreferences.getState().desktop.desktops.some((entry) => entry.id === desktopId))
          throw new BridgeRefusal(BRIDGE_ERRORS.invalid, "No such desktop");
        updatePreference("desktop", (doc) => setDesktopWallpaper(doc, desktopId, spec));
      }
      return null;
    },
    "appearance.setFolderIcon": async ({ icon }) => {
      check();
      if (icon?.kind === "uploaded" && !(await exists("folder-icon", icon.iconId))) throw missing();
      updatePreference("appearance", (current) => {
        const { folderIcon: _previous, ...rest } = current;
        return icon ? { ...rest, folderIcon: icon as FolderIconSpec } : rest;
      });
      return null;
    },
  };
}
