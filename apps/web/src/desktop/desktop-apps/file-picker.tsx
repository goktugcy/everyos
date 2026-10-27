import type { FileEntry, FileRootView } from "@everyos/shared";
import { ChevronRight, File, Folder, HardDrive, Home } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { filesApi } from "../apps/files/lib.ts";

export type PickerRequest =
  | {
      mode: "open";
      accept: string[];
      multiple: boolean;
      directory: boolean;
      write: boolean;
    }
  | { mode: "save"; accept: string[]; suggestedName: string };

export type PickerResult =
  | { mode: "open"; items: Array<{ root: string; path: string }> }
  | { mode: "save"; root: string; path: string; name: string };

const EXTENSION_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  xml: "application/xml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  ics: "text/calendar",
  excalidraw: "application/json",
};

/** Whether a file name matches an `accept` list (`.md`, `text/plain`, `image/*`); empty = all. */
export function matchesAccept(name: string, accept: readonly string[]): boolean {
  if (!accept.length) return true;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const type = EXTENSION_TYPES[extension] ?? "";
  return accept.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule.startsWith(".")) return rule.slice(1) === extension;
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return rule === type;
  });
}

const join = (path: string, name: string) => [path, name].filter(Boolean).join("/");

/**
 * The EveryOS file picker an app asks for: the person browses their own locations (with their own
 * permissions) and decides what the app gets. Drawn by the desktop over the app's window.
 */
export function FilePicker({
  request,
  appName,
  onDone,
}: {
  request: PickerRequest;
  appName: string;
  onDone: (result: PickerResult | null) => void;
}) {
  const { t } = useTranslation();
  const [roots, setRoots] = useState<FileRootView[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState(request.mode === "save" ? request.suggestedName : "");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const writable = request.mode === "save" || (request.mode === "open" && request.write);
  useEffect(() => {
    void filesApi
      .roots()
      .then(({ roots: list }) => {
        const usable = list.filter((entry) => entry.available && (!writable || !entry.readOnly));
        setRoots(usable);
        const home = usable.find((entry) => entry.kind === "home");
        setRoot((home ?? usable[0])?.id ?? null);
        if (home?.folders?.documents) setPath(home.folders.documents);
      })
      .catch(setError);
  }, [writable]);

  useEffect(() => {
    if (!root) return;
    let stale = false;
    filesApi
      .list({ root, path })
      .then((listing) => {
        if (!stale) setEntries(listing.entries);
      })
      .catch((caught: unknown) => {
        if (!stale) setError(caught);
      });
    return () => {
      stale = true;
    };
  }, [root, path]);

  const visible = useMemo(
    () =>
      (entries ?? [])
        .filter(
          (entry) =>
            entry.type === "directory" ||
            (entry.type === "file" &&
              !(request.mode === "open" && request.directory) &&
              matchesAccept(entry.name, request.accept)),
        )
        .sort(
          (a, b) =>
            Number(b.type === "directory") - Number(a.type === "directory") ||
            a.name.localeCompare(b.name),
        ),
    [entries, request],
  );

  /** Moves to another folder; its listing loads afresh and the selection starts empty. */
  const navigate = (nextRoot: string, nextPath: string) => {
    setEntries(null);
    setSelected([]);
    setRoot(nextRoot);
    setPath(nextPath);
  };
  const crumbs = path ? path.split("/") : [];
  const currentRoot = roots?.find((entry) => entry.id === root);
  const toggle = (entryName: string) =>
    setSelected((list) =>
      list.includes(entryName)
        ? list.filter((item) => item !== entryName)
        : request.mode === "open" && request.multiple
          ? [...list, entryName]
          : [entryName],
    );

  const submit = () => {
    if (!root) return;
    if (request.mode === "save") {
      const trimmed = name.trim();
      if (!trimmed || /[/\\]/.test(trimmed)) return;
      const exists = (entries ?? []).some((entry) => entry.name === trimmed);
      if (exists && !confirmReplace) {
        setConfirmReplace(true);
        return;
      }
      onDone({ mode: "save", root, path, name: trimmed });
      return;
    }
    if (request.directory)
      onDone({
        mode: "open",
        items: selected.length
          ? selected.map((entryName) => ({ root, path: join(path, entryName) }))
          : [{ root, path }],
      });
    else if (selected.length)
      onDone({
        mode: "open",
        items: selected.map((entryName) => ({ root, path: join(path, entryName) })),
      });
  };

  const title =
    request.mode === "save"
      ? t("desktopApps.picker.saveTitle")
      : request.directory
        ? t("desktopApps.picker.folderTitle")
        : t("desktopApps.picker.openTitle");

  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/30 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") onDone(null);
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="desktop-app-file-picker"
        className="glass-strong flex h-[min(520px,100%)] w-full max-w-2xl flex-col gap-3 rounded-everyos-lg p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <p className="truncate text-xs text-fg-subtle">
            {t("desktopApps.picker.for", { name: appName })}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          <nav
            aria-label={t("desktopApps.picker.locations")}
            className="flex w-40 shrink-0 flex-col gap-1 overflow-y-auto"
          >
            {(roots ?? []).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => navigate(entry.id, "")}
                className={cn(
                  "flex items-center gap-2 rounded-everyos-sm px-2 py-1.5 text-left text-sm",
                  entry.id === root ? "bg-hover/15 text-fg" : "text-fg-muted hover:bg-hover/8",
                )}
              >
                {entry.kind === "home" ? (
                  <Home className="size-4 shrink-0" aria-hidden />
                ) : (
                  <HardDrive className="size-4 shrink-0" aria-hidden />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
              <button
                type="button"
                className="hover:text-fg"
                onClick={() => root && navigate(root, "")}
              >
                {currentRoot?.name ?? ""}
              </button>
              {crumbs.map((crumb, index) => (
                <span key={`${crumb}-${index}`} className="flex items-center gap-1">
                  <ChevronRight className="size-3" aria-hidden />
                  <button
                    type="button"
                    className="hover:text-fg"
                    onClick={() => root && navigate(root, crumbs.slice(0, index + 1).join("/"))}
                  >
                    {crumb}
                  </button>
                </span>
              ))}
            </div>
            <ul
              role="listbox"
              aria-multiselectable={request.mode === "open" && request.multiple}
              className="glass-inset min-h-0 flex-1 overflow-y-auto rounded-everyos-md p-1"
            >
              {entries === null && !error ? (
                <li className="grid h-full place-items-center">
                  <Spinner className="size-5 text-fg-subtle" label={t("common.loading")} />
                </li>
              ) : visible.length === 0 ? (
                <li className="p-3 text-sm text-fg-subtle">{t("desktopApps.picker.empty")}</li>
              ) : (
                visible.map((entry) => (
                  <li key={entry.name} role="option" aria-selected={selected.includes(entry.name)}>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          entry.type === "directory" &&
                          !(request.mode === "open" && request.directory)
                        ) {
                          if (root) navigate(root, join(path, entry.name));
                          return;
                        }
                        if (request.mode === "save") setName(entry.name);
                        else toggle(entry.name);
                      }}
                      onDoubleClick={() => {
                        if (entry.type === "directory" && root)
                          navigate(root, join(path, entry.name));
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-everyos-sm px-2 py-1.5 text-left text-sm",
                        selected.includes(entry.name)
                          ? "bg-[rgb(var(--everyos-accent)/0.25)] text-fg"
                          : "text-fg hover:bg-hover/8",
                      )}
                    >
                      {entry.type === "directory" ? (
                        <Folder
                          className="size-4 shrink-0 text-[rgb(var(--everyos-accent))]"
                          aria-hidden
                        />
                      ) : (
                        <File className="size-4 shrink-0 text-fg-muted" aria-hidden />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
        {request.mode === "save" ? (
          <label className="flex items-center gap-2 text-sm text-fg">
            <span className="shrink-0">{t("desktopApps.picker.name")}</span>
            <input
              value={name}
              autoFocus
              onChange={(event) => {
                setName(event.target.value.slice(0, 255));
                setConfirmReplace(false);
              }}
              className="glass-inset h-9 min-w-0 flex-1 rounded-everyos-md px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
        ) : null}
        {confirmReplace ? (
          <p role="alert" className="text-sm text-warning">
            {t("desktopApps.picker.replace", { name: name.trim() })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(t, error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={
              !root ||
              (request.mode === "save" ? !name.trim() : !request.directory && selected.length === 0)
            }
          >
            {request.mode === "save"
              ? confirmReplace
                ? t("desktopApps.picker.replaceConfirm")
                : t("common.save")
              : request.directory
                ? t("desktopApps.picker.chooseFolder")
                : t("common.open")}
          </Button>
        </div>
      </form>
    </div>
  );
}
