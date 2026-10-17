import type { FileEntry, FileProperties } from "@everyos/shared";
import {
  File,
  FileArchive,
  FileImage,
  FileQuestion,
  FileText,
  Folder,
  Link2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime, formatNumber } from "../../../lib/format.ts";
import { formatEta, formatRate, useTransfers } from "../../../features/transfers/transfers.ts";
import { FolderIcon } from "./folder-icon.tsx";
import { filesApi, kindOf, nameOf, type FileKind, type FileLocation } from "./lib.ts";

const ICONS: Record<FileKind, LucideIcon> = {
  folder: Folder,
  text: FileText,
  image: FileImage,
  archive: FileArchive,
  link: Link2,
  file: File,
  other: FileQuestion,
};

export function EntryIcon({
  entry,
  className,
  location,
}: {
  entry: Pick<FileEntry, "name" | "type" | "link">;
  className?: string;
  location?: FileLocation | null;
}) {
  const kind = kindOf(entry);
  if (kind === "folder")
    return (
      <FolderIcon
        {...(location ? { location } : {})}
        size={16}
        {...(className ? { className } : {})}
      />
    );
  const Icon = ICONS[kind];
  return <Icon aria-hidden className={className} />;
}

export interface UploadItem {
  id: string;
  name: string;
  loaded: number;
  total: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

/** Compact progress of the current upload queue (status bar). */
export function UploadStatus({ items, onClear }: { items: UploadItem[]; onClear: () => void }) {
  const { t, i18n } = useTranslation();
  const active = items.find((item) => item.status === "uploading");
  const live = useTransfers((state) =>
    active ? state.local.find((transfer) => transfer.id === active.id) : undefined,
  );
  if (items.length === 0) return null;
  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error");
  return (
    <div className="flex min-w-0 items-center gap-2" role="status" data-testid="upload-status">
      {active ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : null}
      <span className="truncate">
        {active
          ? t("files.uploading", {
              name: active.name,
              percent: Math.round((active.loaded / Math.max(1, active.total)) * 100),
              size: formatBytes(active.total, i18n.language),
            })
          : t("files.uploaded", { done, total: items.length })}
      </span>
      {active && live?.state === "running" && live.speed > 0 ? (
        <span className="shrink-0 tabular-nums text-fg-muted" data-testid="upload-speed">
          {formatRate(live.speed, i18n.language, t)}
          {formatEta(live.etaSeconds, t) ? ` · ${formatEta(live.etaSeconds, t)}` : ""}
        </span>
      ) : null}
      {failed.length > 0 ? (
        <span
          className="text-danger"
          title={failed.map((f) => `${f.name}: ${f.error ?? ""}`).join("\n")}
        >
          {t("files.uploadFailed", { count: failed.length })}
        </span>
      ) : null}
      {!active ? (
        <button type="button" className="text-accent hover:underline" onClick={onClear}>
          {t("common.close")}
        </button>
      ) : null}
    </div>
  );
}

export function PropertiesDialog({
  location,
  onClose,
}: {
  location: FileLocation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={location !== null}
      onOpenChange={(open) => !open && onClose()}
      title={location ? nameOf(location.path) || t("files.properties.title") : ""}
      description={t("files.properties.title")}
    >
      {location ? (
        <PropertiesBody key={`${location.root}:${location.path}`} location={location} />
      ) : null}
    </Dialog>
  );
}

/** Loads once per item (the dialog keys it by location). */
function PropertiesBody({ location }: { location: FileLocation }) {
  const { t, i18n } = useTranslation();
  const [properties, setProperties] = useState<FileProperties | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    filesApi.properties(location).then(setProperties, setError);
  }, [location]);
  const rows: Array<[string, string]> = properties
    ? [
        [t("files.properties.type"), t(`files.types.${properties.type}`)],
        [t("files.properties.location"), `/${properties.path}`],
        [
          t("files.properties.size"),
          properties.type === "directory"
            ? t("files.properties.children", { count: properties.children ?? 0 })
            : `${formatBytes(properties.size, i18n.language)} (${formatNumber(properties.size, i18n.language)} B)`,
        ],
        [t("files.properties.modified"), formatDateTime(properties.modifiedAt, i18n.language)],
        [t("files.properties.changed"), formatDateTime(properties.changedAt, i18n.language)],
        ...(properties.createdAt
          ? ([
              [t("files.properties.created"), formatDateTime(properties.createdAt, i18n.language)],
            ] as Array<[string, string]>)
          : []),
        [t("files.properties.permissions"), `${properties.mode} (${properties.octal})`],
        [t("files.properties.owner"), `${properties.owner} : ${properties.group}`],
        ...(properties.link
          ? ([
              [
                t("files.properties.link"),
                properties.link.inside
                  ? t("files.properties.linkInside")
                  : t("files.properties.linkOutside"),
              ],
            ] as Array<[string, string]>)
          : []),
      ]
    : [];
  return (
    <>
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
      {properties ? (
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="break-all font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

export function ImagePreview({
  location,
  onClose,
}: {
  location: FileLocation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={location !== null}
      onOpenChange={(open) => !open && onClose()}
      title={location ? location.path.split("/").at(-1) : ""}
      className="w-[min(94vw,960px)]"
    >
      {location ? (
        <img
          src={filesApi.downloadUrl(location, true)}
          alt={t("files.preview")}
          className="mx-auto max-h-[70vh] rounded-everyos-md object-contain"
        />
      ) : null}
    </Dialog>
  );
}
