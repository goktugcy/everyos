import type { DriveEntry, DriveListing } from "@everyos/shared";
import { DRIVE_ROOT, DRIVE_SHARED } from "@everyos/shared";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Download,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Presentation,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../lib/format.ts";
import { FILES_DRAG_TYPE } from "../../desktop/apps/files/lib.ts";
import { ContextMenuArea } from "../../desktop/menus/menus.tsx";
import type { MenuEntry } from "../../desktop/menus/menu-model.ts";
import { requestConfirm } from "../../desktop/menus/confirm.tsx";
import { driveApi } from "./drive.ts";
import { LocationPicker } from "./pickers.tsx";

const toolbarButton =
  "grid size-8 shrink-0 place-items-center rounded-everyos-sm text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent";

function glyph(entry: DriveEntry) {
  if (entry.folder) return Folder;
  if (entry.exportAs === "docx") return FileText;
  if (entry.exportAs === "xlsx") return FileSpreadsheet;
  if (entry.exportAs === "pptx") return Presentation;
  return File;
}

/** The person's Google Drive inside Files: browse, upload, download, copy into EveryOS. */
export function DriveBrowser({
  folder,
  canWrite,
  onFolder,
  onBack,
}: {
  folder: string;
  canWrite: boolean;
  onFolder: (id: string) => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [listing, setListing] = useState<DriveListing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [copying, setCopying] = useState<DriveEntry | null>(null);
  const [naming, setNaming] = useState<{ entry: DriveEntry | null; name: string } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [more, setMore] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const writable = canWrite && folder !== DRIVE_SHARED;

  useEffect(() => {
    const controller = new AbortController();
    void driveApi.list(folder).then(
      (value) => {
        if (controller.signal.aborted) return;
        setListing(value);
        setSelected(null);
        setError(null);
      },
      (caught: unknown) => !controller.signal.aborted && setError(caught),
    );
    return () => controller.abort();
  }, [folder, revision]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const label = (id: string, name: string) =>
    id === DRIVE_ROOT ? t("drive.myDrive") : id === DRIVE_SHARED ? t("drive.shared") : name;
  const path = listing?.path ?? [];
  const here = [t("drive.title"), ...path.map((step) => label(step.id, step.name))].join(" › ");

  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
      refresh();
    } catch (caught) {
      setError(caught);
    }
  };
  const download = (entry: DriveEntry) => {
    const link = document.createElement("a");
    link.href = driveApi.downloadUrl(entry.id);
    link.download = entry.name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  };
  const open = (entry: DriveEntry) => {
    if (entry.folder) onFolder(entry.id);
    else if (entry.downloadable) download(entry);
  };
  const upload = async (files: File[]) => {
    for (const file of files) {
      try {
        await driveApi.upload(file, folder, here);
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught);
      }
    }
    refresh();
  };
  const trash = async (entry: DriveEntry) => {
    const ok = await requestConfirm({
      title: t("drive.browser.trashTitle", { name: entry.name }),
      body: t("drive.browser.trashBody"),
      confirmLabel: t("drive.browser.trash"),
      danger: true,
    });
    if (ok) await act(() => driveApi.trash(entry.id));
  };
  const commitName = async (event: FormEvent) => {
    event.preventDefault();
    if (!naming?.name.trim()) return;
    const { entry, name } = naming;
    setNaming(null);
    await act(() =>
      entry ? driveApi.rename(entry.id, name.trim()) : driveApi.mkdir(folder, name.trim()),
    );
  };
  const menu = (entry: DriveEntry): MenuEntry[] => [
    entry.folder
      ? {
          kind: "item",
          id: "open",
          label: t("drive.browser.open"),
          icon: <FolderOpen />,
          onSelect: () => onFolder(entry.id),
        }
      : {
          kind: "item",
          id: "download",
          label: t("drive.browser.download"),
          icon: <Download />,
          disabled: !entry.downloadable,
          onSelect: () => download(entry),
        },
    {
      kind: "item",
      id: "copy",
      label: t("drive.browser.copyTo"),
      icon: <Copy />,
      disabled: !entry.downloadable,
      permission: "files:write",
      onSelect: () => setCopying(entry),
    },
    { kind: "separator", id: "s0" },
    {
      kind: "item",
      id: "rename",
      label: t("drive.browser.rename"),
      icon: <Pencil />,
      disabled: !entry.canEdit,
      permission: "files:write",
      onSelect: () => setNaming({ entry, name: entry.name }),
    },
    {
      kind: "item",
      id: "trash",
      label: t("drive.browser.trash"),
      icon: <Trash2 />,
      danger: true,
      disabled: !entry.canEdit,
      permission: "files:write",
      onSelect: () => void trash(entry),
    },
  ];

  /** Files from this computer upload; EveryOS files dragged from Files windows are copied. */
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDropping(false);
    if (!writable) return;
    const raw = event.dataTransfer.getData(FILES_DRAG_TYPE);
    if (raw) {
      try {
        const data = JSON.parse(raw) as { root: string; paths: string[] };
        void (async () => {
          for (const path of data.paths)
            await driveApi
              .transfer({ kind: "files", root: data.root, path }, { kind: "drive", id: folder })
              .then((started) => setNotice(t("drive.browser.started", { name: started.name })))
              .catch(setError);
        })();
      } catch {
        // Not a drag from Files.
      }
      return;
    }
    const files = [...event.dataTransfer.items]
      .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
      .map((item) => item.getAsFile())
      .filter((file): file is globalThis.File => file !== null);
    if (files.length) void upload(files);
  };

  const parent = path.length > 1 ? path.at(-2)!.id : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="drive-browser">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          className={toolbarButton}
          aria-label={t("files.back")}
          onClick={() => (parent ? onFolder(parent) : onBack())}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[0.9rem]"
          aria-label={t("files.breadcrumb")}
        >
          {path.map((step, index) => (
            <span key={step.id} className="flex min-w-0 items-center gap-0.5">
              {index ? (
                <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              ) : null}
              <button
                type="button"
                className={cn(
                  "truncate rounded px-1.5 py-0.5 hover:bg-hover/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  index === path.length - 1 && "font-semibold",
                )}
                onClick={() => onFolder(step.id)}
                data-testid={index === path.length - 1 ? "files-title" : undefined}
              >
                {label(step.id, step.name)}
              </button>
            </span>
          ))}
        </nav>
        {writable ? (
          <>
            <button
              type="button"
              className={toolbarButton}
              aria-label={t("drive.browser.newFolder")}
              title={t("drive.browser.newFolder")}
              onClick={() => setNaming({ entry: null, name: t("drive.browser.newFolderName") })}
            >
              <FolderPlus className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              className={toolbarButton}
              aria-label={t("drive.browser.upload")}
              title={t("drive.browser.upload")}
              onClick={() => input.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={toolbarButton}
          aria-label={t("drive.browser.refresh")}
          title={t("drive.browser.refresh")}
          onClick={refresh}
        >
          <RefreshCw className="size-4" aria-hidden />
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void upload(files);
          }}
        />
      </div>
      <div className="flex shrink-0 gap-1 px-3 pt-2">
        {([DRIVE_ROOT, DRIVE_SHARED] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={cn(
              "rounded-full px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent",
              path[0]?.id === id
                ? "bg-accent/15 font-medium text-accent"
                : "text-fg-muted hover:bg-hover/10",
            )}
            onClick={() => onFolder(id)}
          >
            {label(id, "")}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-auto p-2",
          dropping && "bg-[rgb(var(--everyos-accent)/0.08)] ring-2 ring-inset ring-accent",
        )}
        onDragOver={(event) => {
          if (!writable) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget) setDropping(false);
        }}
        onDrop={onDrop}
      >
        {error ? (
          <div className="p-2">
            <Alert tone="danger" onDismiss={() => setError(null)}>
              {errorMessage(t, error)}
            </Alert>
          </div>
        ) : null}
        {!listing && !error ? (
          <div className="grid h-40 place-items-center">
            <Spinner className="size-5" />
          </div>
        ) : null}
        {listing && listing.entries.length === 0 ? (
          <p className="p-6 text-center text-sm text-fg-muted">
            {writable ? t("drive.browser.dropHint") : t("drive.browser.empty")}
          </p>
        ) : null}
        {listing && listing.entries.length > 0 ? (
          <table className="w-full table-fixed text-left text-[0.82rem]">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">{t("drive.browser.name")}</th>
                <th className="w-28 px-2 py-1.5 font-medium max-sm:hidden">
                  {t("drive.browser.size")}
                </th>
                <th className="w-44 px-2 py-1.5 font-medium max-md:hidden">
                  {t("drive.browser.modified")}
                </th>
              </tr>
            </thead>
            <tbody>
              {listing.entries.map((entry) => {
                const Icon = glyph(entry);
                return (
                  <ContextMenuArea key={entry.id} entries={() => menu(entry)}>
                    <tr
                      tabIndex={0}
                      data-testid="drive-row"
                      data-name={entry.name}
                      aria-selected={selected === entry.id}
                      className={cn(
                        "cursor-default rounded outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        selected === entry.id ? "bg-accent/15" : "hover:bg-hover/8",
                        !entry.downloadable && "opacity-60",
                      )}
                      title={
                        entry.exportAs
                          ? t("drive.browser.googleFile", { extension: entry.exportAs })
                          : entry.downloadable
                            ? entry.name
                            : t("drive.browser.notDownloadable")
                      }
                      onClick={() => setSelected(entry.id)}
                      onContextMenu={() => setSelected(entry.id)}
                      onDoubleClick={() => open(entry)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") open(entry);
                      }}
                    >
                      <td className="px-2 py-1.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <Icon
                            className={cn(
                              "size-4 shrink-0",
                              entry.folder ? "text-accent" : "text-fg-muted",
                            )}
                            aria-hidden
                          />
                          <span className="truncate">{entry.name}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-fg-muted max-sm:hidden">
                        {entry.sizeBytes !== null
                          ? formatBytes(entry.sizeBytes, i18n.language)
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-fg-muted max-md:hidden">
                        {entry.modifiedAt ? formatDateTime(entry.modifiedAt, i18n.language) : "—"}
                      </td>
                    </tr>
                  </ContextMenuArea>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {listing?.nextPageToken ? (
          <div className="flex justify-center p-2">
            <Button
              size="sm"
              variant="ghost"
              loading={more}
              onClick={() => {
                setMore(true);
                void driveApi
                  .list(folder, listing.nextPageToken!)
                  .then((page) =>
                    setListing((current) =>
                      current ? { ...page, entries: [...current.entries, ...page.entries] } : page,
                    ),
                  )
                  .catch(setError)
                  .finally(() => setMore(false));
              }}
            >
              {t("drive.browser.loadMore")}
            </Button>
          </div>
        ) : null}
      </div>
      {notice ? (
        <div
          className="flex shrink-0 items-center border-t border-line px-3 py-1.5 text-xs text-fg-muted"
          role="status"
          data-testid="drive-notice"
        >
          {notice}
        </div>
      ) : null}
      {copying ? (
        <LocationPicker
          title={t("drive.browser.pickLocation", { name: copying.name })}
          confirmLabel={t("drive.browser.copyHere")}
          onClose={() => setCopying(null)}
          onPick={(location) => {
            const entry = copying;
            setCopying(null);
            void driveApi
              .transfer({ kind: "drive", id: entry.id }, { kind: "files", ...location })
              .then((started) => setNotice(t("drive.browser.started", { name: started.name })))
              .catch(setError);
          }}
        />
      ) : null}
      {naming ? (
        <Dialog
          open
          onOpenChange={(value) => !value && setNaming(null)}
          title={naming.entry ? t("drive.browser.rename") : t("drive.browser.newFolder")}
        >
          <form
            className="flex flex-col gap-4 px-6 py-5"
            onSubmit={(event) => void commitName(event)}
          >
            <Field
              label={t("drive.browser.name")}
              value={naming.name}
              autoFocus
              maxLength={255}
              onChange={(event) => setNaming({ ...naming, name: event.target.value })}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setNaming(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!naming.name.trim()}>
                {t("common.save")}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
