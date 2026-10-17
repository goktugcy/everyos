import type { FileRootView } from "@everyos/shared";
import { DRIVE_ROOT } from "@everyos/shared";
import { ChevronRight, Cloud, Folder, HardDrive, House, Usb } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { filesApi, joinPath, type FileLocation } from "../../desktop/apps/files/lib.ts";
import { driveApi } from "./drive.ts";

interface Folder {
  key: string;
  name: string;
}

/** A folder browser in a dialog: breadcrumbs, the folders here, and one button to choose. */
function FolderPicker({
  title,
  confirmLabel,
  crumbs,
  folders,
  loading,
  error,
  canChoose,
  aside,
  onCrumb,
  onOpen,
  onChoose,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  crumbs: Array<{ key: string; name: string }>;
  folders: Folder[] | null;
  loading: boolean;
  error: unknown;
  canChoose: boolean;
  aside?: ReactNode;
  onCrumb: (index: number) => void;
  onOpen: (folder: Folder) => void;
  onChoose: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title}>
      <div className="flex min-h-0 flex-col gap-3 px-6 py-5" data-testid="folder-picker">
        {aside}
        <nav
          className="flex flex-wrap items-center gap-0.5 text-sm"
          aria-label={t("files.breadcrumb")}
        >
          {crumbs.map((crumb, index) => (
            <span key={crumb.key} className="flex items-center gap-0.5">
              {index ? <ChevronRight className="size-3.5 text-fg-subtle" aria-hidden /> : null}
              <button
                type="button"
                className="rounded px-1.5 py-0.5 hover:bg-hover/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => onCrumb(index)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <ul className="glass-inset flex h-64 flex-col overflow-y-auto rounded-everyos-md p-1.5">
          {loading ? (
            <li className="grid flex-1 place-items-center">
              <Spinner className="size-5" />
            </li>
          ) : null}
          {!loading && folders?.length === 0 ? (
            <li className="p-3 text-sm text-fg-muted">{t("drive.browser.empty")}</li>
          ) : null}
          {!loading
            ? folders?.map((folder) => (
                <li key={folder.key}>
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onDoubleClick={() => onOpen(folder)}
                    onClick={() => onOpen(folder)}
                  >
                    <Folder className="size-4 shrink-0 text-accent" aria-hidden />
                    <span className="truncate">{folder.name}</span>
                  </button>
                </li>
              ))
            : null}
        </ul>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={busy}
            disabled={!canChoose}
            onClick={() => {
              setBusy(true);
              onChoose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const ROOT_ICONS = { home: House, location: HardDrive, disk: Usb, system: HardDrive } as const;

/** Chooses a writable EveryOS folder (home, locations, disks). */
export function LocationPicker({
  title,
  confirmLabel,
  onPick,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  onPick: (location: FileLocation) => void;
  onClose: () => void;
}) {
  const [roots, setRoots] = useState<FileRootView[] | null>(null);
  const [at, setAt] = useState<FileLocation | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; folders: Folder[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const atKey = at ? `${at.root}:${at.path}` : "";
  const folders = loaded?.key === atKey ? loaded.folders : null;
  useEffect(() => {
    void filesApi
      .roots()
      .then(
        (value) =>
          setRoots(
            value.roots.filter(
              (root) => root.available && !root.readOnly && root.kind !== "system",
            ),
          ),
        setError,
      );
  }, []);
  useEffect(() => {
    if (!at) return;
    const controller = new AbortController();
    const key = `${at.root}:${at.path}`;
    void filesApi.list(at).then(
      (listing) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            folders: listing.entries
              .filter((entry) => entry.type === "directory")
              .map((entry) => ({ key: entry.name, name: entry.name })),
          });
      },
      (caught: unknown) => !controller.signal.aborted && setError(caught),
    );
    return () => controller.abort();
  }, [at]);
  const root = roots?.find((candidate) => candidate.id === at?.root);
  const parts = at?.path.split("/").filter(Boolean) ?? [];
  return (
    <FolderPicker
      title={title}
      confirmLabel={confirmLabel}
      crumbs={[
        { key: "roots", name: "EveryOS" },
        ...(root ? [{ key: `root:${root.id}`, name: root.name }] : []),
        ...parts.map((part, index) => ({ key: `${index}:${part}`, name: part })),
      ]}
      folders={
        at
          ? folders
          : (roots?.map((candidate) => ({ key: candidate.id, name: candidate.name })) ?? null)
      }
      loading={at ? folders === null : roots === null}
      error={error}
      canChoose={at !== null}
      aside={
        !at && roots ? (
          <div className="flex flex-wrap gap-2">
            {roots.map((candidate) => {
              const Icon = ROOT_ICONS[candidate.kind];
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className="glass-inset flex items-center gap-2 rounded-everyos-sm px-3 py-1.5 text-sm hover:bg-hover/10"
                  onClick={() => setAt({ root: candidate.id, path: "" })}
                >
                  <Icon className="size-4 text-accent" aria-hidden />
                  {candidate.name}
                </button>
              );
            })}
          </div>
        ) : null
      }
      onCrumb={(index) =>
        setAt(
          index === 0 ? null : at && { root: at.root, path: parts.slice(0, index - 1).join("/") },
        )
      }
      onOpen={(folder) =>
        setAt(
          at
            ? { root: at.root, path: joinPath(at.path, folder.name) }
            : { root: folder.key, path: "" },
        )
      }
      onChoose={() => at && onPick(at)}
      onClose={onClose}
    />
  );
}

/** Chooses a folder of My Drive. */
export function DriveFolderPicker({
  title,
  confirmLabel,
  onPick,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  onPick: (folderId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState<Array<{ key: string; name: string }>>([
    { key: DRIVE_ROOT, name: t("drive.myDrive") },
  ]);
  const [loaded, setLoaded] = useState<{ key: string; folders: Folder[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const current = path.at(-1)!.key;
  const folders = loaded?.key === current ? loaded.folders : null;
  useEffect(() => {
    const controller = new AbortController();
    void driveApi.list(current).then(
      (listing) => {
        if (!controller.signal.aborted)
          setLoaded({
            key: current,
            folders: listing.entries
              .filter((entry) => entry.folder)
              .map((entry) => ({ key: entry.id, name: entry.name })),
          });
      },
      (caught: unknown) => !controller.signal.aborted && setError(caught),
    );
    return () => controller.abort();
  }, [current]);
  return (
    <FolderPicker
      title={title}
      confirmLabel={confirmLabel}
      crumbs={path}
      folders={folders}
      loading={folders === null && !error}
      error={error}
      canChoose
      aside={
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Cloud className="size-4 text-accent" aria-hidden />
          {t("drive.title")}
        </p>
      }
      onCrumb={(index) => setPath((steps) => steps.slice(0, index + 1))}
      onOpen={(folder) => setPath((steps) => [...steps, folder])}
      onChoose={() => onPick(current)}
      onClose={onClose}
    />
  );
}
