import {
  FOLDER_ICON_PRESET_IDS,
  MAX_FOLDER_ICON_BYTES,
  WALLPAPER_MIME_TYPES,
  type FolderIconSpec,
  type WallpaperInfo,
} from "@otuken/shared";
import { Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { flushPending, updatePreference, usePreferences } from "../../state/preferences-store.ts";
import { FolderIcon } from "../files/folder-icon.tsx";
import { nameOf, type FileLocation } from "../files/lib.ts";

export function FolderIconPicker({
  value,
  onChange,
}: {
  value: FolderIconSpec;
  onChange: (icon: FolderIconSpec) => void;
}) {
  const { t } = useTranslation();
  const uploads = useApiResource<{ icons: WallpaperInfo[] }>("/folder-icons", null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const upload = async (file: File) => {
    setError(null);
    if (!(WALLPAPER_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(new ApiRequestError(415, "UNSUPPORTED_MEDIA_TYPE", "type"));
      return;
    }
    if (file.size > MAX_FOLDER_ICON_BYTES) {
      setError(new ApiRequestError(413, "PAYLOAD_TOO_LARGE", "size"));
      return;
    }
    setBusy(true);
    try {
      const icon = await api<WallpaperInfo>("/folder-icons", {
        method: "POST",
        raw: { body: file, contentType: file.type },
      });
      uploads.reload();
      onChange({ kind: "uploaded", iconId: icon.id });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      await flushPending();
      await api(`/folder-icons/${encodeURIComponent(id)}`, { method: "DELETE" });
      uploads.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const displayError = (caught: unknown) => {
    if (caught instanceof ApiRequestError) {
      if (caught.code === "WALLPAPER_INVALID") return t("folderIcons.invalid");
      if (caught.code === "WALLPAPER_QUOTA_EXCEEDED") return t("folderIcons.quota");
      if (caught.code === "CONFLICT") return t("folderIcons.inUse");
    }
    return errorMessage(t, caught);
  };
  const tiles: { spec: FolderIconSpec; label: string }[] = [
    ...FOLDER_ICON_PRESET_IDS.map((id) => ({
      spec: { kind: "preset" as const, id },
      label: t(`folderIcons.presets.${id}`),
    })),
    ...(uploads.data?.icons ?? []).map((icon, index) => ({
      spec: { kind: "uploaded" as const, iconId: icon.id },
      label: t("folderIcons.uploaded", { number: index + 1 }),
    })),
  ];
  return (
    <div className="flex flex-col gap-3">
      <ul
        role="radiogroup"
        aria-label={t("folderIcons.title")}
        className="grid grid-cols-[repeat(auto-fill,minmax(90px,1fr))] gap-2"
      >
        {tiles.map(({ spec, label }) => {
          const selected = JSON.stringify(value) === JSON.stringify(spec);
          const id = spec.kind === "preset" ? spec.id : spec.iconId;
          return (
            <li key={id} className="relative">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                disabled={busy}
                onClick={() => onChange(spec)}
                data-folder-icon-option={id}
                className={cn(
                  "flex w-full flex-col items-center gap-1 rounded-otk-md border p-2 outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50",
                  selected ? "border-accent bg-accent/10" : "border-line hover:bg-hover/8",
                )}
              >
                <FolderIcon spec={spec} size={48} />
                <span className="text-xs text-fg">{label}</span>
              </button>
              {spec.kind === "uploaded" && !selected ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("folderIcons.deleteUpload", { name: label })}
                  onClick={() => void remove(spec.iconId)}
                  className="absolute right-1 top-1 grid size-6 place-items-center rounded text-fg-muted outline-none hover:bg-danger/15 hover:text-danger focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">{t("folderIcons.uploadHint")}</p>
      <input
        ref={fileRef}
        type="file"
        accept={WALLPAPER_MIME_TYPES.join(",")}
        aria-label={t("folderIcons.upload")}
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
      <Button
        variant="secondary"
        disabled={busy}
        loading={busy}
        onClick={() => fileRef.current?.click()}
      >
        <Upload className="size-4" aria-hidden />
        {t("folderIcons.upload")}
      </Button>
      {uploads.loading ? <p className="text-xs text-fg-muted">{t("common.loading")}</p> : null}
      {error || uploads.error ? (
        <Alert tone="danger">{displayError(error ?? uploads.error)}</Alert>
      ) : null}
    </div>
  );
}

/** Folder-specific preferences affect this user's view without changing host files. */
export function FolderIconDialog({
  location,
  onClose,
}: {
  location: FileLocation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const appearance = usePreferences((state) => state.appearance);
  const override = appearance.folderIcons?.find(
    (item) => location && item.root === location.root && item.path === location.path,
  );
  const full = !override && (appearance.folderIcons?.length ?? 0) >= 500;
  const apply = (icon: FolderIconSpec | null) => {
    if (!location || (full && icon !== null)) return;
    updatePreference("appearance", (current) => ({
      ...current,
      folderIcons: [
        ...(current.folderIcons ?? []).filter(
          (item) => item.root !== location.root || item.path !== location.path,
        ),
        ...(icon ? [{ ...location, icon }] : []),
      ],
    }));
  };
  return (
    <Dialog
      open={location !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("folderIcons.folderTitle", { name: location ? nameOf(location.path) : "" })}
      className="z-[9000]"
      overlayClassName="z-[8900]"
    >
      {location ? (
        <div className="flex flex-col gap-4">
          {full ? (
            <Alert tone="danger">{t("folderIcons.limit")}</Alert>
          ) : (
            <FolderIconPicker
              value={override?.icon ?? appearance.folderIcon ?? { kind: "preset", id: "classic" }}
              onChange={apply}
            />
          )}
          <Button variant="secondary" disabled={!override} onClick={() => apply(null)}>
            {t("folderIcons.useDefault")}
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
