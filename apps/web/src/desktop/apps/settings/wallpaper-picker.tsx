import {
  MAX_WALLPAPER_BYTES,
  WALLPAPER_MIME_TYPES,
  WALLPAPER_PRESET_IDS,
  type WallpaperInfo,
  type WallpaperSpec,
} from "@everyos/shared";
import { Check, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Slider } from "../../../components/ui/slider.tsx";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { setDesktopWallpaper } from "../../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../../state/preferences-store.ts";
import { useWindowManager } from "../../state/window-store.ts";
import { WallpaperView } from "../../wallpaper/wallpaper-view.tsx";

type Scope = "all" | "current";

function sameSpec(a: WallpaperSpec | null, b: WallpaperSpec | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function Tile({
  selected,
  label,
  onClick,
  children,
  onDelete,
  deleteLabel,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        title={label}
        onClick={onClick}
        className={cn(
          "relative block aspect-[16/10] w-full overflow-hidden rounded-everyos-md border outline-none focus-visible:ring-2 focus-visible:ring-accent",
          selected ? "border-accent ring-2 ring-accent" : "border-line",
        )}
      >
        {children}
        {selected ? (
          <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full button-accent">
            <Check className="size-3" aria-hidden />
          </span>
        ) : null}
      </button>
      <span className="mt-1 block truncate text-center text-xs text-fg-muted">{label}</span>
      {onDelete ? (
        <button
          type="button"
          aria-label={deleteLabel}
          title={deleteLabel}
          onClick={onDelete}
          className="absolute left-1.5 top-1.5 hidden size-6 place-items-center rounded-full bg-black/60 text-white hover:bg-danger group-focus-within:grid group-hover:grid"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

/** Choose built-in, solid, gradient or uploaded wallpapers for all desktops or just the current one. */
export function WallpaperPicker() {
  const { t } = useTranslation();
  const appearanceWallpaper = usePreferences((state) => state.appearance.wallpaper);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const desktopWallpaper = usePreferences(
    (state) => state.desktop.desktops.find((d) => d.id === activeDesktopId)?.wallpaper ?? null,
  );
  const multipleDesktops = usePreferences((state) => state.desktop.desktops.length > 1);
  const [scope, setScope] = useState<Scope>(desktopWallpaper ? "current" : "all");
  const [uploads, setUploads] = useState<WallpaperInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [solid, setSolid] = useState("#1e293b");
  const [gradient, setGradient] = useState({ from: "#0f172a", to: "#4338ca", angle: 135 });
  const fileRef = useRef<HTMLInputElement>(null);

  const current = scope === "current" ? desktopWallpaper : appearanceWallpaper;
  const apply = (spec: WallpaperSpec | null) => {
    if (scope === "current")
      updatePreference("desktop", (doc) => setDesktopWallpaper(doc, activeDesktopId, spec));
    else updatePreference("appearance", (a) => ({ ...a, wallpaper: spec }));
  };

  useEffect(() => {
    const controller = new AbortController();
    api<{ wallpapers: WallpaperInfo[] }>("/wallpapers", { signal: controller.signal }).then(
      (result) => setUploads(result.wallpapers),
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  const upload = async (file: File) => {
    setError(null);
    if (!(WALLPAPER_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(new ApiRequestError(415, "WALLPAPER_INVALID", "type"));
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      setError(new ApiRequestError(413, "PAYLOAD_TOO_LARGE", "size"));
      return;
    }
    setUploading(true);
    try {
      const info = await api<WallpaperInfo>("/wallpapers", {
        method: "POST",
        raw: { body: file, contentType: file.type },
      });
      setUploads((list) => [info, ...list]);
      apply({ kind: "image", wallpaperId: info.id, fit: "cover" });
    } catch (caught) {
      setError(caught);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (info: WallpaperInfo) => {
    setError(null);
    try {
      await api(`/wallpapers/${encodeURIComponent(info.id)}`, { method: "DELETE" });
      setUploads((list) => list.filter((item) => item.id !== info.id));
      if (current?.kind === "image" && current.wallpaperId === info.id) apply(null);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {multipleDesktops ? (
        <Select
          label={t("settings.appearance.wallpaperScope")}
          value={scope}
          options={[
            { value: "all", label: t("settings.appearance.wallpaperAll") },
            { value: "current", label: t("settings.appearance.wallpaperCurrent") },
          ]}
          onChange={setScope}
        />
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          {t("settings.appearance.presets")}
        </p>
        <ul
          role="radiogroup"
          aria-label={t("settings.appearance.presets")}
          className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3"
        >
          <Tile
            selected={current === null}
            label={t("settings.appearance.themeDefault")}
            onClick={() => apply(null)}
          >
            <span className="grid size-full place-items-center bg-hover/10 text-xs text-fg-muted">
              Aa
            </span>
          </Tile>
          {WALLPAPER_PRESET_IDS.map((id) => {
            const spec: WallpaperSpec = { kind: "preset", id };
            return (
              <Tile
                key={id}
                selected={sameSpec(current, spec)}
                label={t(`wallpapers.${id}`)}
                onClick={() => apply(spec)}
              >
                <WallpaperView spec={spec} />
              </Tile>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("settings.appearance.uploads")}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept={WALLPAPER_MIME_TYPES.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-4" aria-hidden />
            {uploading ? t("settings.appearance.uploading") : t("settings.appearance.upload")}
          </Button>
        </div>
        <p className="text-xs text-fg-muted">{t("settings.appearance.uploadHint")}</p>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        {uploads.length > 0 ? (
          <ul
            role="radiogroup"
            aria-label={t("settings.appearance.uploads")}
            className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3"
          >
            {uploads.map((info) => {
              const spec: WallpaperSpec = {
                kind: "image",
                wallpaperId: info.id,
                fit: current?.kind === "image" ? current.fit : "cover",
              };
              return (
                <Tile
                  key={info.id}
                  selected={current?.kind === "image" && current.wallpaperId === info.id}
                  label={`${info.width}×${info.height}`}
                  onClick={() => apply(spec)}
                  onDelete={() => void remove(info)}
                  deleteLabel={t("settings.appearance.deleteWallpaper")}
                >
                  <img
                    src={`/api/wallpapers/${encodeURIComponent(info.id)}/image`}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </Tile>
              );
            })}
          </ul>
        ) : null}
        {current?.kind === "image" ? (
          <Select
            label={t("settings.appearance.fit")}
            value={current.fit}
            options={[
              { value: "cover", label: t("settings.appearance.fitCover") },
              { value: "contain", label: t("settings.appearance.fitContain") },
            ]}
            onChange={(fit) => apply({ ...current, fit })}
          />
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("settings.appearance.solidColor")}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={solid}
              onChange={(e) => setSolid(e.target.value)}
              aria-label={t("settings.appearance.solidColor")}
              className="h-10 w-14 cursor-pointer rounded-everyos-sm border border-line bg-transparent"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => apply({ kind: "solid", color: solid })}
            >
              {t("common.confirm")}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("settings.appearance.gradient")}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={gradient.from}
              onChange={(e) => setGradient((g) => ({ ...g, from: e.target.value }))}
              aria-label={`${t("settings.appearance.gradient")} 1`}
              className="h-10 w-14 cursor-pointer rounded-everyos-sm border border-line bg-transparent"
            />
            <input
              type="color"
              value={gradient.to}
              onChange={(e) => setGradient((g) => ({ ...g, to: e.target.value }))}
              aria-label={`${t("settings.appearance.gradient")} 2`}
              className="h-10 w-14 cursor-pointer rounded-everyos-sm border border-line bg-transparent"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => apply({ kind: "gradient", ...gradient })}
            >
              {t("common.confirm")}
            </Button>
          </div>
          <Slider
            label="°"
            value={gradient.angle}
            min={0}
            max={360}
            step={5}
            onChange={(angle) => setGradient((g) => ({ ...g, angle }))}
            format={(v) => `${v}°`}
          />
        </div>
      </div>
    </div>
  );
}
