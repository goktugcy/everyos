import type { FileProperties, FileRootView, ShelfItem } from "@everyos/shared";
import {
  Download,
  File,
  FileArchive,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Upload,
  X,
} from "lucide-react";
import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatBytes } from "../../lib/format.ts";
import { randomId } from "../../lib/random-id.ts";
import { usePermissions } from "../../stores/session-store.ts";
import {
  FILES_DRAG_TYPE,
  filesApi,
  filesChanged,
  parentOf,
  uploadUnique,
} from "../apps/files/lib.ts";
import { desktop } from "../state/controller.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { readFilesDrag, shelfAdd, shelfName, shelfRemove } from "./pulse-lib.ts";

interface Upload {
  id: string;
  name: string;
  loaded: number;
  total: number;
  error: string | null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|xz|bz2|7z|rar|zst)$/i;
const TEXT = /\.(txt|md|json|ya?ml|toml|ini|conf|log|csv|xml|html?|css|js|ts|sh|py|env)$/i;

function ItemIcon({ item }: { item: ShelfItem }) {
  const name = shelfName(item);
  const Icon =
    item.kind === "directory"
      ? Folder
      : IMAGE.test(name)
        ? FileImage
        : ARCHIVE.test(name)
          ? FileArchive
          : TEXT.test(name)
            ? FileText
            : File;
  return <Icon className="size-8 text-fg" strokeWidth={1.4} aria-hidden />;
}

const setShelf = (update: (shelf: ShelfItem[]) => ShelfItem[]) =>
  updatePreference("pulse", (doc) => ({ ...doc, shelf: update(doc.shelf) }));

/**
 * The shelf: references to files in EveryOS's file locations. Files dropped
 * from the computer are uploaded to the chosen destination first; files
 * dragged from a Files window are only referenced. Items can be dragged back
 * into any Files window (move, or copy with Alt/Ctrl) or onto the computer.
 */
export function PulseShelf() {
  const { t, i18n } = useTranslation();
  const canWrite = usePermissions().includes("files:write");
  const shelf = usePreferences((state) => state.pulse.shelf);
  const destination = usePreferences((state) => state.pulse.destination);
  const roots = useApiResource<{ roots: FileRootView[] }>("/files/roots", null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [choosing, setChoosing] = useState(false);

  const writable = (roots.data?.roots ?? []).filter((root) => root.available && !root.readOnly);
  // Like a browser's downloads: by default into the user's own Downloads folder.
  const home = writable.find((root) => root.kind === "home");
  const target =
    destination && writable.some((root) => root.id === destination.root)
      ? destination
      : home
        ? { root: home.id, path: home.folders?.downloads ?? "" }
        : writable[0]
          ? { root: writable[0].id, path: "" }
          : null;
  const targetName = target
    ? [writable.find((root) => root.id === target.root)?.name ?? target.root, target.path]
        .filter(Boolean)
        .join(" / ")
    : null;

  const uploadAll = async (files: File[]) => {
    if (!target) return;
    const added: ShelfItem[] = [];
    for (const file of files) {
      const id = randomId();
      setUploads((list) => [
        ...list,
        { id, name: file.name, loaded: 0, total: file.size, error: null },
      ]);
      const progress = (loaded: number, total: number) =>
        setUploads((list) => list.map((u) => (u.id === id ? { ...u, loaded, total } : u)));
      try {
        const name = await uploadUnique(target, file, progress);
        added.push({
          root: target.root,
          path: [target.path, name].filter(Boolean).join("/"),
          kind: "file",
          size: file.size,
          addedAt: Date.now(),
        });
        setUploads((list) => list.filter((u) => u.id !== id));
      } catch (caught) {
        setUploads((list) =>
          list.map((u) => (u.id === id ? { ...u, error: errorMessage(t, caught) } : u)),
        );
      }
    }
    if (added.length) {
      setShelf((current) => shelfAdd(current, added));
      filesChanged();
    }
  };

  const reference = async (data: { root: string; paths: string[] }) => {
    const items = await Promise.all(
      data.paths.map(async (path): Promise<ShelfItem | null> => {
        try {
          const properties: FileProperties = await filesApi.properties({ root: data.root, path });
          return {
            root: data.root,
            path,
            kind: properties.type === "directory" ? "directory" : "file",
            size: properties.type === "directory" ? null : properties.size,
            addedAt: Date.now(),
          };
        } catch (caught) {
          setError(caught);
          return null;
        }
      }),
    );
    const found = items.filter((item): item is ShelfItem => item !== null);
    if (found.length) setShelf((current) => shelfAdd(current, found));
  };

  const accept = (event: DragEvent) => {
    const types = [...event.dataTransfer.types];
    if (!types.includes(FILES_DRAG_TYPE) && !types.includes("Files")) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "link";
    return true;
  };

  const drop = (event: DragEvent) => {
    if (!accept(event)) return;
    setOver(false);
    setError(null);
    const data = readFilesDrag(event.dataTransfer.getData(FILES_DRAG_TYPE));
    if (data) {
      void reference(data);
      return;
    }
    // Folders cannot be uploaded from the browser; they arrive as empty "files".
    const files = [...event.dataTransfer.items]
      .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length && canWrite && target) void uploadAll(files);
  };

  return (
    <div
      className="flex h-full gap-4 text-fg"
      onDragOver={(event) => {
        if (accept(event)) setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={drop}
      data-testid="pulse-shelf"
    >
      <section
        className={cn(
          "flex w-56 shrink-0 flex-col gap-2 rounded-2xl border border-dashed p-3 transition-colors",
          over ? "border-[rgb(var(--everyos-accent))] bg-hover/10" : "border-line bg-hover/5",
        )}
        data-testid="pulse-dropzone"
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
          <Upload className="size-6 text-fg-muted" aria-hidden />
          <p className="text-[0.8rem] font-medium">{t("pulse.shelf.drop")}</p>
          <p className="text-[0.68rem] leading-snug text-fg-muted">
            {!canWrite
              ? t("pulse.shelf.readOnly")
              : target
                ? t("pulse.shelf.uploadTo", { target: targetName })
                : t("pulse.shelf.noTarget")}
          </p>
          {canWrite && writable.length > 0 ? (
            <button
              type="button"
              onClick={() => setChoosing((value) => !value)}
              className="text-[0.68rem] font-medium text-[rgb(var(--everyos-accent))] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("pulse.shelf.change")}
            </button>
          ) : null}
        </div>
        {choosing && target ? (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const rawPath = form.get("path");
              const root = form.get("root");
              if (typeof root !== "string") return;
              const path = (typeof rawPath === "string" ? rawPath : "")
                .trim()
                .replace(/^\/+|\/+$/g, "");
              updatePreference("pulse", (doc) => ({
                ...doc,
                destination: { root, path },
              }));
              setChoosing(false);
            }}
          >
            <label className="sr-only" htmlFor="pulse-root">
              {t("pulse.shelf.location")}
            </label>
            <select
              id="pulse-root"
              name="root"
              defaultValue={target.root}
              className="h-7 rounded-md bg-hover/10 px-2 text-[0.72rem] text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {writable.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.name}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="pulse-path">
              {t("pulse.shelf.folder")}
            </label>
            <input
              id="pulse-path"
              name="path"
              defaultValue={target.path}
              placeholder={t("pulse.shelf.folderPlaceholder")}
              className="h-7 rounded-md bg-hover/10 px-2 text-[0.72rem] text-fg outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-accent"
            />
            <button
              type="submit"
              className="h-7 rounded-md bg-hover/20 text-[0.72rem] font-medium outline-none hover:bg-hover/25 focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("common.save")}
            </button>
          </form>
        ) : null}
        {uploads.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="pulse-uploads">
            {uploads.map((upload) => (
              <li key={upload.id} className="flex flex-col gap-0.5 text-[0.68rem]">
                <span className="flex justify-between gap-2">
                  <span className="truncate">{upload.name}</span>
                  {upload.error ? (
                    <button
                      type="button"
                      aria-label={t("common.close")}
                      onClick={() => setUploads((list) => list.filter((u) => u.id !== upload.id))}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  ) : null}
                </span>
                {upload.error ? (
                  <span className="text-[rgb(var(--everyos-danger))]">{upload.error}</span>
                ) : (
                  <span className="h-1 overflow-hidden rounded-full bg-hover/15">
                    <span
                      className="block h-full bg-[rgb(var(--everyos-accent))]"
                      style={{
                        width: `${upload.total ? (upload.loaded / upload.total) * 100 : 0}%`,
                      }}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[0.68rem] font-semibold uppercase tracking-wider text-fg-subtle">
            {t("pulse.shelf.items", { count: shelf.length })}
          </h3>
          {shelf.length > 0 ? (
            <button
              type="button"
              onClick={() => setShelf(() => [])}
              className="text-[0.7rem] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("pulse.shelf.clear")}
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="mb-1 text-[0.7rem] text-[rgb(var(--everyos-danger))]">
            {errorMessage(t, error)}
          </p>
        ) : null}
        {shelf.length === 0 ? (
          <p className="text-[0.75rem] text-fg-subtle">{t("pulse.shelf.empty")}</p>
        ) : (
          <ul
            className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(86px,1fr))] content-start gap-2 overflow-y-auto pr-1"
            data-testid="pulse-shelf-items"
          >
            {shelf.map((item) => {
              const name = shelfName(item);
              const location = { root: item.root, path: item.path };
              const url = filesApi.downloadUrl(location);
              return (
                <li
                  key={`${item.root}:${item.path}`}
                  className="group relative flex flex-col items-center gap-1 rounded-xl p-2 text-center hover:bg-hover/8"
                  draggable
                  data-testid="pulse-shelf-item"
                  title={`${name}${item.size !== null ? ` · ${formatBytes(item.size, i18n.language)}` : ""}`}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      FILES_DRAG_TYPE,
                      JSON.stringify({ root: item.root, paths: [item.path] }),
                    );
                    // Chrome and Edge save it to the computer when dropped outside the browser.
                    if (item.kind === "file")
                      event.dataTransfer.setData(
                        "DownloadURL",
                        `application/octet-stream:${name}:${new URL(url, window.location.href).href}`,
                      );
                    event.dataTransfer.effectAllowed = "copyMove";
                  }}
                  onDragEnd={(event) => {
                    // Moved into a folder: it is no longer where the shelf points.
                    if (event.dataTransfer.dropEffect === "move")
                      setShelf((current) => shelfRemove(current, item));
                  }}
                >
                  <ItemIcon item={item} />
                  <span className="line-clamp-2 w-full break-all text-[0.68rem] leading-tight text-fg">
                    {name}
                  </span>
                  <span className="absolute right-1 top-1 hidden gap-0.5 group-focus-within:flex group-hover:flex">
                    <button
                      type="button"
                      aria-label={t("pulse.shelf.show", { name })}
                      title={t("pulse.shelf.show", { name })}
                      onClick={() =>
                        desktop.openApp("everyos.files", {
                          newInstance: true,
                          appState: {
                            root: item.root,
                            path: item.kind === "directory" ? item.path : parentOf(item.path),
                          },
                        })
                      }
                      className="grid size-5 place-items-center rounded-full bg-[rgb(var(--everyos-surface)/0.9)] text-fg hover:text-fg"
                    >
                      <FolderOpen className="size-3" aria-hidden />
                    </button>
                    {item.kind === "file" ? (
                      <a
                        href={url}
                        download={name}
                        aria-label={t("pulse.shelf.download", { name })}
                        title={t("pulse.shelf.download", { name })}
                        className="grid size-5 place-items-center rounded-full bg-[rgb(var(--everyos-surface)/0.9)] text-fg hover:text-fg"
                      >
                        <Download className="size-3" aria-hidden />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t("pulse.shelf.remove", { name })}
                      title={t("pulse.shelf.remove", { name })}
                      onClick={() => setShelf((current) => shelfRemove(current, item))}
                      className="grid size-5 place-items-center rounded-full bg-[rgb(var(--everyos-surface)/0.9)] text-fg hover:text-fg"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
