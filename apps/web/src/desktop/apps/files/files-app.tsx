import type {
  FileEntry,
  FileListing,
  FileRootsResponse,
  FileRootView,
  FileSearchResult,
  StandardFolder,
} from "@everyos/shared";
import type { Point, Rect } from "@everyos/window-manager";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Info,
  LayoutGrid,
  Link,
  List,
  Palette,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { ApiRequestError, uploadWithProgress } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import type { MenuEntry } from "../../menus/menu-model.ts";
import { ContextMenuArea } from "../../menus/menus.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";
import { openTerminalEntries } from "../../menus/terminal-entry.tsx";
import { desktop } from "../../state/controller.ts";
import { iconsInRect, selectionRect } from "../../surface/icon-selection.ts";
import { useAppHost } from "../app-context.ts";
import {
  copyName,
  FILES_DRAG_TYPE,
  filesApi,
  filesChanged,
  freeName,
  isFolder,
  joinPath,
  kindOf,
  nameOf,
  parentOf,
  useFileClipboard,
  useFilesRevision,
  type FileLocation,
} from "./lib.ts";
import {
  EntryIcon,
  ImagePreview,
  PropertiesDialog,
  UploadStatus,
  type UploadItem,
} from "./parts.tsx";
import { FILES_FOLDER_ICONS as FOLDER_ICONS, FilesSidebar } from "./sidebar.tsx";
import { FolderIconDialog } from "../settings/folder-icon-picker.tsx";
import { FileIconView } from "./icon-view.tsx";

type ViewMode = "icons" | "list";

type SortKey = "name" | "size" | "modifiedAt" | "kind";
const DRAG_TYPE = FILES_DRAG_TYPE;

const toolbarButton =
  "grid size-8 shrink-0 place-items-center rounded-everyos-sm text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent";

function useLocationState(roots: FileRootView[] | null) {
  const host = useAppHost();
  const state = (host.appState ?? {}) as Partial<FileLocation>;
  const root =
    roots?.find((r) => r.id === state.root && r.available)?.id ??
    roots?.find((r) => r.available)?.id ??
    null;
  const location: FileLocation | null = root
    ? { root, path: state.root === root ? (state.path ?? "") : "" }
    : null;
  return { location, host };
}

export default function FilesApp() {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canWrite = permissions.includes("files:write");
  const [roots, setRoots] = useState<FileRootView[] | null>(null);
  const [system, setSystem] = useState<FileRootsResponse["system"] | null>(null);
  const [rootsError, setRootsError] = useState<unknown>(null);
  const { location, host } = useLocationState(roots);
  const [back, setBack] = useState<FileLocation[]>([]);
  const [forward, setForward] = useState<FileLocation[]>([]);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const selecting = useRef<{
    pointerId: number;
    start: Point;
    bounds: Map<string, Rect>;
    initial: ReadonlySet<string>;
    additive: boolean;
    toggle: boolean;
  } | null>(null);
  const anchor = useRef<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "name",
    descending: false,
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [results, setResults] = useState<FileSearchResult | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [properties, setProperties] = useState<FileLocation | null>(null);
  const [iconLocation, setIconLocation] = useState<FileLocation | null>(null);
  const [preview, setPreview] = useState<FileLocation | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clipboard = useFileClipboard();
  const changes = useFilesRevision();
  const listRef = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const root = roots?.find((r) => r.id === location?.root) ?? null;
  const writable = Boolean(canWrite && root && !root.readOnly);

  const loadRoots = useCallback(
    () =>
      filesApi.roots().then((value) => {
        setRoots(value.roots);
        setSystem(value.system);
      }, setRootsError),
    [],
  );

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  // Finder's default is the icon view; each window remembers its own choice.
  const view: ViewMode =
    (host.appState as { view?: unknown } | undefined)?.view === "list" ? "list" : "icons";
  const setView = (next: ViewMode) => {
    endMarquee();
    host.setAppState({ ...(host.appState as object | undefined), view: next });
  };

  const toggleSystem = async (enabled: boolean) => {
    if (
      enabled &&
      !(await requestConfirm({
        title: t("files.systemConfirm.title"),
        body: t("files.systemConfirm.body"),
        confirmLabel: t("files.systemConfirm.confirm"),
      }))
    )
      return;
    setActionError(null);
    try {
      await filesApi.setSystemRoots(enabled);
      if (!enabled && location?.root.startsWith("sys-")) go({ root: "home", path: "" });
      await loadRoots();
    } catch (caught) {
      setActionError(caught);
    }
  };

  useEffect(() => {
    if (!location) return;
    const controller = new AbortController();
    filesApi
      .list(location, hidden)
      .then((value) => {
        if (controller.signal.aborted) return;
        setListing(value);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the location's fields identify it
  }, [location?.root, location?.path, hidden, revision, changes]);

  useEffect(() => {
    host.setTitle(location?.path ? nameOf(location.path) : (root?.name ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- title follows the location
  }, [location?.path, root?.name]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  const go = (next: FileLocation, record = true) => {
    endMarquee();
    if (location && record) {
      setBack((stack) => [...stack.slice(-49), location]);
      setForward([]);
    }
    setSelected(new Set());
    setRenaming(null);
    setResults(null);
    setSearchText("");
    host.setAppState({
      ...(host.appState as object | undefined),
      root: next.root,
      path: next.path,
    });
  };

  const entries = useMemo(() => {
    const list = [...(listing?.entries ?? [])];
    const direction = sort.descending ? -1 : 1;
    const collator = new Intl.Collator(i18n.language, { numeric: true, sensitivity: "base" });
    list.sort((a, b) => {
      const folders = Number(isFolder(b)) - Number(isFolder(a));
      if (folders !== 0) return folders;
      const value =
        sort.key === "size"
          ? a.size - b.size
          : sort.key === "modifiedAt"
            ? a.modifiedAt - b.modifiedAt
            : sort.key === "kind"
              ? collator.compare(kindOf(a), kindOf(b))
              : 0;
      return (value || collator.compare(a.name, b.name)) * direction;
    });
    return list;
  }, [listing, sort, i18n.language]);

  const names = useMemo(() => new Set(entries.map((e) => e.name)), [entries]);
  const selectedPaths = () => [...selected].map((name) => joinPath(location!.path, name));

  // Every change is announced, so other windows and the desktop list again too.
  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      filesChanged();
      return true;
    } catch (caught) {
      setActionError(caught);
      filesChanged();
      return false;
    }
  };

  /* ------------------------------ actions ------------------------------ */

  const open = (entry: FileEntry) => {
    if (!location) return;
    const target = { root: location.root, path: joinPath(location.path, entry.name) };
    const kind = kindOf(entry);
    if (kind === "folder") go(target);
    else if (kind === "image") setPreview(target);
    else if (kind === "text") desktop.openWindow("everyos.editor", target);
    else download([target.path]);
  };

  const download = (paths: string[]) => {
    if (!location) return;
    for (const path of paths) {
      const link = document.createElement("a");
      link.href = filesApi.downloadUrl({ root: location.root, path });
      link.download = nameOf(path);
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    }
  };

  const remove = async (paths: string[]) => {
    if (!location || paths.length === 0) return;
    const ok = await requestConfirm({
      title: t("files.deleteConfirm.title", { count: paths.length }),
      body:
        paths.length === 1
          ? t("files.deleteConfirm.one", { name: nameOf(paths[0]!) })
          : t("files.deleteConfirm.many", { count: paths.length }),
      confirmLabel: t("files.deleteConfirm.confirm"),
      danger: true,
    });
    if (ok && (await run(() => filesApi.remove(location.root, paths)))) setSelected(new Set());
  };

  const createFolder = async () => {
    if (!location) return;
    const name = freeName(t("files.newFolderName"), names);
    if (await run(() => filesApi.mkdir(location, name))) {
      setSelected(new Set([name]));
      setRenaming(name);
    }
  };

  const createTextFile = async () => {
    if (!location) return;
    const name = freeName(t("files.newFileName"), names);
    if (
      await run(() =>
        filesApi.writeText({ root: location.root, path: joinPath(location.path, name) }, "", null),
      )
    ) {
      setSelected(new Set([name]));
      setRenaming(name);
    }
  };

  const commitRename = async (from: string, to: string) => {
    setRenaming(null);
    const name = to.trim();
    if (!location || !name || name === from) return;
    if (
      await run(() =>
        filesApi.rename({ root: location.root, path: joinPath(location.path, from) }, name),
      )
    )
      setSelected(new Set([name]));
  };

  const duplicate = async (entry: FileEntry) => {
    if (!location) return;
    const name = copyName(entry.name, names, t("files.copySuffix"));
    await run(() =>
      filesApi.copy(location.root, [joinPath(location.path, entry.name)], location, name),
    );
  };

  const paste = async (into: FileLocation | null = location) => {
    if (!into || !clipboard) return;
    const done = await run(() =>
      clipboard.mode === "cut"
        ? filesApi.move(clipboard.root, clipboard.paths, into)
        : filesApi.copy(clipboard.root, clipboard.paths, into),
    );
    if (done && clipboard.mode === "cut") useFileClipboard.setState(null, true);
  };

  const transfer = async (
    source: { root: string; paths: string[] },
    into: FileLocation,
    copy: boolean,
  ) => {
    // Dropping onto the current folder (or an item onto itself) changes nothing.
    const effective = source.paths.filter(
      (p) => parentOf(p) !== into.path || source.root !== into.root,
    );
    if (
      effective.some(
        (p) => source.root === into.root && (into.path === p || into.path.startsWith(`${p}/`)),
      )
    )
      return;
    if (effective.length === 0) return;
    await run(() =>
      copy
        ? filesApi.copy(source.root, effective, into)
        : filesApi.move(source.root, effective, into),
    );
  };

  const upload = async (files: File[], into: FileLocation | null = location) => {
    if (!into || files.length === 0) return;
    const items: UploadItem[] = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      loaded: 0,
      total: file.size,
      status: "queued",
    }));
    setUploads((current) => [
      ...current.filter((u) => u.status === "uploading" || u.status === "queued"),
      ...items,
    ]);
    const update = (id: string, patch: Partial<UploadItem>) =>
      setUploads((current) => current.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    for (const [index, file] of files.entries()) {
      const item = items[index]!;
      update(item.id, { status: "uploading" });
      const send = (overwrite: boolean) =>
        uploadWithProgress(filesApi.uploadPath(into, file.name, overwrite), file, (loaded, total) =>
          update(item.id, { loaded, total }),
        );
      try {
        try {
          await send(false);
        } catch (caught) {
          if (!(caught instanceof ApiRequestError && caught.code === "CONFLICT")) throw caught;
          const replace = await requestConfirm({
            title: t("files.replaceConfirm.title"),
            body: t("files.replaceConfirm.body", { name: file.name }),
            confirmLabel: t("files.replaceConfirm.confirm"),
            danger: true,
          });
          if (!replace) {
            update(item.id, { status: "error", error: t("files.skipped") });
            continue;
          }
          await send(true);
        }
        update(item.id, { status: "done", loaded: file.size });
      } catch (caught) {
        update(item.id, { status: "error", error: errorMessage(t, caught) });
      }
    }
    filesChanged();
  };

  /* ----------------------------- selection ----------------------------- */

  const endMarquee = () => {
    const id = selecting.current?.pointerId;
    selecting.current = null;
    setMarquee(null);
    if (id !== undefined && listRef.current?.hasPointerCapture(id))
      listRef.current.releasePointerCapture(id);
  };

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Portal events bubble through React, but menus are outside the selection surface.
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      renaming ||
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target) ||
      event.target.closest("[data-name], button, input, select, textarea, a, thead")
    )
      return;
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    if (
      event.clientX >= box.left + element.clientWidth ||
      event.clientY >= box.top + element.clientHeight
    )
      return;
    event.preventDefault();
    element.focus();
    const bounds = new Map<string, Rect>();
    element.querySelectorAll<HTMLElement>("[data-name]").forEach((item) => {
      const rect = item.getBoundingClientRect();
      bounds.set(item.dataset.name!, {
        x: rect.x - box.x + element.scrollLeft,
        y: rect.y - box.y + element.scrollTop,
        width: rect.width,
        height: rect.height,
      });
    });
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    selecting.current = {
      pointerId: event.pointerId,
      start: {
        x: event.clientX - box.x + element.scrollLeft,
        y: event.clientY - box.y + element.scrollTop,
      },
      bounds,
      initial: selected,
      additive,
      toggle: event.ctrlKey || event.metaKey,
    };
    if (!additive) setSelected(new Set());
    element.setPointerCapture(event.pointerId);
  };

  const extendMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selecting.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    const rect = selectionRect(drag.start, {
      x: Math.max(0, Math.min(element.clientWidth, event.clientX - box.x)) + element.scrollLeft,
      y: Math.max(0, Math.min(element.clientHeight, event.clientY - box.y)) + element.scrollTop,
    });
    const next = new Set(drag.additive ? drag.initial : []);
    for (const name of iconsInRect(rect, drag.bounds)) {
      if (drag.toggle && next.has(name)) next.delete(name);
      else next.add(name);
    }
    setSelected(next);
    setMarquee(rect);
  };

  const finishMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selecting.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.type === "pointercancel" || event.type === "lostpointercapture")
      setSelected(new Set(drag.initial));
    endMarquee();
  };

  const select = (
    name: string,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => {
    if (event.shiftKey && anchor.current) {
      const from = entries.findIndex((e) => e.name === anchor.current);
      const to = entries.findIndex((e) => e.name === name);
      const [a, b] = from < to ? [from, to] : [to, from];
      setSelected(new Set(entries.slice(a, b + 1).map((e) => e.name)));
      return;
    }
    anchor.current = name;
    if (event.metaKey || event.ctrlKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    } else setSelected(new Set([name]));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming || !location) return;
    if (event.key === "Escape") {
      endMarquee();
      setSelected(new Set());
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const index = entries.findIndex((e) => e.name === anchor.current);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        entries[
          Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
        ];
      if (next) {
        select(next.name, { shiftKey: event.shiftKey, metaKey: false, ctrlKey: false });
        if (!event.shiftKey) anchor.current = next.name;
        listRef.current
          ?.querySelector(`[data-name="${CSS.escape(next.name)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter" && selected.size === 1) {
      const entry = entries.find((e) => selected.has(e.name));
      if (entry) open(entry);
    } else if (event.key === "Backspace" && location.path) {
      go({ root: location.root, path: parentOf(location.path) });
    } else if (
      (event.key === "Delete" || (event.key === "Backspace" && mod)) &&
      writable &&
      selected.size > 0
    ) {
      void remove(selectedPaths());
    } else if (event.key === "F2" && writable && selected.size === 1) {
      setRenaming([...selected][0]!);
    } else if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(entries.map((e) => e.name)));
    } else if (
      mod &&
      (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "x") &&
      selected.size > 0
    ) {
      if (event.key.toLowerCase() === "x" && !writable) return;
      useFileClipboard.setState(
        {
          mode: event.key.toLowerCase() === "x" ? "cut" : "copy",
          root: location.root,
          paths: selectedPaths(),
        },
        true,
      );
    } else if (mod && event.key.toLowerCase() === "v" && writable && clipboard) {
      void paste();
    }
  };

  /* ---------------------------- drag and drop ---------------------------- */

  const dragData = (event: DragEvent): { root: string; paths: string[] } | null => {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    try {
      return raw ? (JSON.parse(raw) as { root: string; paths: string[] }) : null;
    } catch {
      return null;
    }
  };

  const allowDrop = (event: DragEvent, target: string) => {
    if (!writable) return;
    const types = [...event.dataTransfer.types];
    if (!types.includes(DRAG_TYPE) && !types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      types.includes("Files") || event.altKey || event.ctrlKey ? "copy" : "move";
    setDropTarget(target);
  };

  const drop = (event: DragEvent, into: FileLocation) => {
    if (!writable) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const data = dragData(event);
    if (data) void transfer(data, into, event.altKey || event.ctrlKey);
    else if (event.dataTransfer.files.length > 0) {
      // Folders cannot be uploaded from the browser; they arrive as empty "files".
      const files = [...event.dataTransfer.items]
        .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      void upload(files, into);
    }
  };

  /* --------------------------- shared item props --------------------------- */

  /** Selection, opening, dragging and dropping, the same in the list and icon views. */
  const itemProps = (entry: FileEntry) => {
    const isSelected = selected.has(entry.name);
    const folder = isFolder(entry);
    return {
      "data-name": entry.name,
      "data-testid": "file-row",
      "aria-selected": isSelected,
      draggable: writable && renaming !== entry.name,
      onDragStart: (event: DragEvent) => {
        if (!location) return;
        const names = isSelected ? [...selected] : [entry.name];
        if (!isSelected) setSelected(new Set([entry.name]));
        event.dataTransfer.setData(
          DRAG_TYPE,
          JSON.stringify({
            root: location.root,
            paths: names.map((n) => joinPath(location.path, n)),
          }),
        );
        event.dataTransfer.effectAllowed = "copyMove";
      },
      onDragOver: folder ? (event: DragEvent) => allowDrop(event, `row:${entry.name}`) : undefined,
      onDragLeave: folder ? () => setDropTarget(null) : undefined,
      onDrop: folder
        ? (event: DragEvent) =>
            location &&
            drop(event, { root: location.root, path: joinPath(location.path, entry.name) })
        : undefined,
      onClick: (event: React.MouseEvent) => select(entry.name, event),
      onContextMenu: () => {
        if (!isSelected) setSelected(new Set([entry.name]));
      },
      onDoubleClick: () => open(entry),
    };
  };

  /** The type glyph of a standard home folder (Desktop, Documents…), as in Finder. */
  const standardIcon = (entry: FileEntry) => {
    if (root?.kind !== "home" || location?.path || !root.folders || !isFolder(entry)) return null;
    const kind = (Object.keys(root.folders) as StandardFolder[]).find(
      (key) => root.folders?.[key] === entry.name,
    );
    return kind ? FOLDER_ICONS[kind] : null;
  };

  const isCut = (entry: FileEntry) =>
    clipboard?.mode === "cut" &&
    clipboard.root === location?.root &&
    clipboard.paths.includes(joinPath(location?.path ?? "", entry.name));

  const renameField = (entry: FileEntry, className: string) => (
    <input
      autoFocus
      defaultValue={entry.name}
      aria-label={t("files.menu.rename")}
      className={cn("glass-inset rounded px-1 text-sm outline-none", className)}
      onFocus={(event) => {
        const dot = entry.name.lastIndexOf(".");
        event.currentTarget.setSelectionRange(
          0,
          dot > 0 && !isFolder(entry) ? dot : entry.name.length,
        );
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") void commitRename(entry.name, event.currentTarget.value);
        if (event.key === "Escape") setRenaming(null);
      }}
      onBlur={(event) => void commitRename(entry.name, event.currentTarget.value)}
    />
  );

  /* ------------------------------- menus ------------------------------- */

  const itemMenu = (entry: FileEntry): MenuEntry[] => {
    if (!location) return [];
    const paths = selected.has(entry.name)
      ? selectedPaths()
      : [joinPath(location.path, entry.name)];
    const single = paths.length === 1;
    const folder = isFolder(entry);
    return [
      {
        kind: "item",
        id: "open",
        label: t("files.menu.open"),
        icon: <FolderOpen />,
        disabled: !single,
        onSelect: () => open(entry),
      },
      ...(!folder && kindOf(entry) !== "link"
        ? [
            {
              kind: "item" as const,
              id: "download",
              label: t("files.menu.download"),
              icon: <Download />,
              onSelect: () => download(paths),
            },
          ]
        : []),
      { kind: "separator", id: "s1" },
      {
        kind: "item",
        id: "cut",
        label: t("files.menu.cut"),
        icon: <Scissors />,
        shortcut: "Ctrl+X",
        disabled: !writable,
        onSelect: () =>
          useFileClipboard.setState({ mode: "cut", root: location.root, paths }, true),
      },
      {
        kind: "item",
        id: "copy",
        label: t("files.menu.copy"),
        icon: <Copy />,
        shortcut: "Ctrl+C",
        onSelect: () =>
          useFileClipboard.setState({ mode: "copy", root: location.root, paths }, true),
      },
      ...(folder
        ? [
            {
              kind: "item" as const,
              id: "paste",
              label: t("files.menu.pasteInto"),
              icon: <ClipboardPaste />,
              disabled: !writable || !clipboard || !single,
              onSelect: () => void paste({ root: location.root, path: paths[0]! }),
            },
          ]
        : []),
      ...(folder && single && permissions.includes("preferences:manage")
        ? [
            {
              kind: "item" as const,
              id: "folder-icon",
              label: t("folderIcons.change"),
              icon: <Palette />,
              onSelect: () => setIconLocation({ root: location.root, path: paths[0]! }),
            },
          ]
        : []),
      { kind: "separator", id: "s2" },
      {
        kind: "item",
        id: "rename",
        label: t("files.menu.rename"),
        icon: <Pencil />,
        shortcut: "F2",
        disabled: !writable || !single,
        onSelect: () => setRenaming(entry.name),
      },
      {
        kind: "item",
        id: "duplicate",
        label: t("files.menu.duplicate"),
        icon: <Copy />,
        disabled: !writable || !single,
        onSelect: () => void duplicate(entry),
      },
      {
        kind: "item",
        id: "copyPath",
        label: t("files.menu.copyPath"),
        icon: <Link />,
        disabled: !single,
        onSelect: () =>
          void navigator.clipboard?.writeText(`${root?.name ?? location.root}:/${paths[0]}`),
      },
      {
        kind: "item",
        id: "properties",
        label: t("files.menu.properties"),
        icon: <Info />,
        disabled: !single,
        onSelect: () => setProperties({ root: location.root, path: paths[0]! }),
      },
      { kind: "separator", id: "s3" },
      {
        kind: "item",
        id: "delete",
        label: t("files.menu.delete"),
        icon: <Trash2 />,
        danger: true,
        disabled: !writable,
        onSelect: () => void remove(paths),
      },
    ];
  };

  const backgroundMenu = (): MenuEntry[] => [
    {
      kind: "item",
      id: "folder",
      label: t("files.menu.newFolder"),
      icon: <FolderPlus />,
      disabled: !writable,
      onSelect: () => void createFolder(),
    },
    {
      kind: "item",
      id: "file",
      label: t("files.menu.newFile"),
      icon: <FilePlus2 />,
      disabled: !writable,
      onSelect: () => void createTextFile(),
    },
    {
      kind: "item",
      id: "upload",
      label: t("files.menu.upload"),
      icon: <Upload />,
      disabled: !writable,
      onSelect: () => uploadInput.current?.click(),
    },
    {
      kind: "item",
      id: "paste",
      label: t("files.menu.paste"),
      icon: <ClipboardPaste />,
      shortcut: "Ctrl+V",
      disabled: !writable || !clipboard,
      onSelect: () => void paste(),
    },
    { kind: "separator", id: "s" },
    {
      kind: "check",
      id: "view-icons",
      label: t("files.view.icons"),
      checked: view === "icons",
      onCheckedChange: () => setView("icons"),
    },
    {
      kind: "check",
      id: "view-list",
      label: t("files.view.list"),
      checked: view === "list",
      onCheckedChange: () => setView("list"),
    },
    { kind: "separator", id: "s2" },
    ...openTerminalEntries(t("desktop.menu.openTerminal"), permissions),
    {
      kind: "item",
      id: "refresh",
      label: t("files.menu.refresh"),
      icon: <RefreshCw />,
      onSelect: refresh,
    },
  ];

  /* ------------------------------- render ------------------------------- */

  if (rootsError)
    return (
      <div className="p-6">
        <Alert
          tone={
            rootsError instanceof ApiRequestError && rootsError.code === "FILES_DISABLED"
              ? "info"
              : "danger"
          }
        >
          {rootsError instanceof ApiRequestError && rootsError.code === "FILES_DISABLED"
            ? t("files.disabled")
            : errorMessage(t, rootsError)}
        </Alert>
      </div>
    );
  if (!roots) return null;

  const segments = location?.path.split("/").filter(Boolean) ?? [];
  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <th
      scope="col"
      aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}
      className={cn("px-2 py-1.5 font-semibold", className)}
    >
      <button
        type="button"
        className="rounded px-1 hover:text-fg"
        onClick={() => setSort((s) => ({ key, descending: s.key === key ? !s.descending : false }))}
      >
        {label}
        {sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <div className="flex h-full min-h-0" data-testid="files-app">
      <FilesSidebar
        roots={roots}
        system={system}
        location={location}
        onGo={(next) => go(next)}
        onSystem={(enabled) => void toggleSystem(enabled)}
        drops={{ allowDrop, drop, dropTarget, clearDrop: () => setDropTarget(null) }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
          <button
            type="button"
            className={toolbarButton}
            aria-label={t("files.back")}
            title={t("files.back")}
            disabled={back.length === 0}
            onClick={() => {
              const previous = back.at(-1)!;
              setBack((s) => s.slice(0, -1));
              if (location) setForward((s) => [...s, location]);
              go(previous, false);
            }}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={toolbarButton}
            aria-label={t("files.forward")}
            title={t("files.forward")}
            disabled={forward.length === 0}
            onClick={() => {
              const next = forward.at(-1)!;
              setForward((s) => s.slice(0, -1));
              if (location) setBack((s) => [...s, location]);
              go(next, false);
            }}
          >
            <ArrowRight className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={toolbarButton}
            aria-label={t("files.up")}
            title={t("files.up")}
            disabled={!location?.path}
            onClick={() => location && go({ root: location.root, path: parentOf(location.path) })}
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>

          <h2
            className="min-w-0 flex-1 truncate px-1 text-[0.9rem] font-semibold"
            data-testid="files-title"
          >
            {location?.path ? nameOf(location.path) : (root?.name ?? "")}
          </h2>

          <div
            role="group"
            aria-label={t("files.view.label")}
            className="glass-inset flex h-8 shrink-0 items-center rounded-everyos-sm p-0.5"
          >
            {(["icons", "list"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                aria-label={t(`files.view.${mode}`)}
                title={t(`files.view.${mode}`)}
                onClick={() => setView(mode)}
                className={cn(
                  "grid h-7 w-8 place-items-center rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  view === mode ? "bg-hover/15 text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {mode === "icons" ? (
                  <LayoutGrid className="size-4" aria-hidden />
                ) : (
                  <List className="size-4" aria-hidden />
                )}
              </button>
            ))}
          </div>

          <form
            role="search"
            className="glass-inset flex h-8 items-center gap-1.5 rounded-everyos-sm px-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!location || !searchText.trim()) return;
              filesApi.search(location, searchText.trim()).then(setResults, setActionError);
            }}
          >
            <Search className="size-3.5 text-fg-subtle" aria-hidden />
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("files.search")}
              aria-label={t("files.search")}
              className="w-32 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
            />
            {results ? (
              <button
                type="button"
                aria-label={t("files.clearSearch")}
                onClick={() => {
                  setResults(null);
                  setSearchText("");
                }}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </form>
          <button
            type="button"
            className={toolbarButton}
            aria-label={t("files.menu.newFolder")}
            title={t("files.menu.newFolder")}
            disabled={!writable}
            onClick={() => void createFolder()}
          >
            <FolderPlus className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={toolbarButton}
            aria-label={t("files.menu.upload")}
            title={t("files.menu.upload")}
            disabled={!writable}
            onClick={() => uploadInput.current?.click()}
          >
            <Upload className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={toolbarButton}
            aria-pressed={hidden}
            aria-label={t("files.showHidden")}
            title={t("files.showHidden")}
            onClick={() => setHidden((h) => !h)}
          >
            {hidden ? (
              <Eye className="size-4" aria-hidden />
            ) : (
              <EyeOff className="size-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            className={toolbarButton}
            aria-label={t("files.menu.refresh")}
            title={t("files.menu.refresh")}
            onClick={refresh}
          >
            <RefreshCw className="size-4" aria-hidden />
          </button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void upload([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </div>

        {actionError ? (
          <div className="px-3 pt-2">
            <Alert tone="danger">{errorMessage(t, actionError)}</Alert>
          </div>
        ) : null}

        {results ? (
          <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="file-search-results">
            <p className="px-2 pb-2 text-xs text-fg-muted">
              {t("files.results", { count: results.results.length })}
              {results.truncated ? ` · ${t("files.resultsTruncated")}` : ""}
            </p>
            <ul className="flex flex-col">
              {results.results.map((result) => (
                <li key={result.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-everyos-sm px-2 py-1.5 text-left text-sm hover:bg-hover/8"
                    onClick={() => {
                      if (!location) return;
                      const folder = result.type === "directory";
                      go({
                        root: location.root,
                        path: folder ? result.path : parentOf(result.path),
                      });
                      if (!folder) setSelected(new Set([result.name]));
                    }}
                  >
                    <EntryIcon
                      entry={{ name: result.name, type: result.type, link: null }}
                      location={location ? { root: location.root, path: result.path } : null}
                      className="size-4 shrink-0"
                    />
                    <span className="truncate font-medium">{result.name}</span>
                    <span className="truncate text-xs text-fg-subtle">
                      /{parentOf(result.path)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ContextMenuArea entries={backgroundMenu}>
            <div
              ref={listRef}
              tabIndex={0}
              role="grid"
              aria-label={t("files.listLabel", {
                name: location?.path ? nameOf(location.path) : (root?.name ?? ""),
              })}
              aria-multiselectable
              className={cn(
                "relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                dropTarget === "list" && "bg-[rgb(var(--everyos-accent)/0.06)]",
              )}
              onKeyDown={onKeyDown}
              onPointerDown={beginMarquee}
              onPointerMove={extendMarquee}
              onPointerUp={finishMarquee}
              onPointerCancel={finishMarquee}
              onLostPointerCapture={finishMarquee}
              onDragOver={(event) => allowDrop(event, "list")}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDropTarget(null);
              }}
              onDrop={(event) => location && drop(event, location)}
              data-testid="file-list"
            >
              {error ? (
                <div className="p-4">
                  <Alert tone="danger">{errorMessage(t, error)}</Alert>
                </div>
              ) : view === "icons" ? (
                <FileIconView
                  location={location}
                  entries={entries}
                  selected={selected}
                  renaming={renaming}
                  dropTarget={dropTarget}
                  itemProps={itemProps}
                  isCut={isCut}
                  renameField={renameField}
                  menuFor={itemMenu}
                  badge={standardIcon}
                  thumbnail={(entry) =>
                    location && kindOf(entry) === "image" && entry.size <= 8 * 1024 * 1024
                      ? filesApi.downloadUrl(
                          { root: location.root, path: joinPath(location.path, entry.name) },
                          true,
                        )
                      : null
                  }
                />
              ) : (
                <table className="w-full min-w-[520px] table-fixed text-left text-sm">
                  <colgroup>
                    <col />
                    <col className="w-24" />
                    <col className="w-36" />
                    <col className="w-28" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-[rgb(var(--everyos-surface)/0.95)] text-xs text-fg-muted">
                    <tr>
                      {sortHeader("name", t("files.columns.name"))}
                      {sortHeader("size", t("files.columns.size"), "text-right")}
                      {sortHeader("modifiedAt", t("files.columns.modified"))}
                      {sortHeader("kind", t("files.columns.kind"))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const isSelected = selected.has(entry.name);
                      const folder = isFolder(entry);
                      const Standard = standardIcon(entry);
                      return (
                        <ContextMenuArea key={entry.name} entries={() => itemMenu(entry)}>
                          <tr
                            {...itemProps(entry)}
                            className={cn(
                              "cursor-default select-none border-t border-line",
                              isSelected
                                ? "bg-[rgb(var(--everyos-accent)/0.2)]"
                                : "hover:bg-hover/5",
                              isCut(entry) && "opacity-50",
                              dropTarget === `row:${entry.name}` &&
                                "outline outline-2 -outline-offset-2 outline-accent",
                            )}
                          >
                            <td className="max-w-0 px-2 py-1">
                              <div className="flex min-w-0 items-center gap-2">
                                {Standard && !isFolder(entry) ? (
                                  <Standard className="size-4 shrink-0 text-accent" aria-hidden />
                                ) : (
                                  <EntryIcon
                                    entry={entry}
                                    location={
                                      location
                                        ? {
                                            root: location.root,
                                            path: joinPath(location.path, entry.name),
                                          }
                                        : null
                                    }
                                    className="size-4 shrink-0"
                                  />
                                )}
                                {renaming === entry.name ? (
                                  renameField(entry, "min-w-0 flex-1")
                                ) : (
                                  <span className="truncate" title={entry.name}>
                                    {entry.name}
                                  </span>
                                )}
                                {entry.link && !entry.link.inside ? (
                                  <span
                                    className="shrink-0 text-[0.65rem] text-warning"
                                    title={t("files.outsideLink")}
                                  >
                                    ↗
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-fg-muted">
                              {folder ? "—" : formatBytes(entry.size, i18n.language)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1 text-fg-muted">
                              {formatDateTime(entry.modifiedAt, i18n.language, {
                                dateStyle: "short",
                                timeStyle: "short",
                              })}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1 text-fg-muted">
                              {t(`files.kinds.${kindOf(entry)}`)}
                            </td>
                          </tr>
                        </ContextMenuArea>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {listing && entries.length === 0 && !error ? (
                <p className="p-8 text-center text-sm text-fg-muted">
                  {writable ? t("files.emptyWritable") : t("files.empty")}
                </p>
              ) : null}
              {marquee ? (
                <div
                  aria-hidden
                  data-testid="files-selection-area"
                  className="pointer-events-none absolute z-20 rounded-sm border border-accent bg-accent/15"
                  style={{
                    left: marquee.x,
                    top: marquee.y,
                    width: marquee.width,
                    height: marquee.height,
                  }}
                />
              ) : null}
            </div>
          </ContextMenuArea>
        )}

        {/* Finder's path bar: every folder on the way is a button and a drop target. */}
        <div className="flex shrink-0 items-center border-t border-line px-2 py-1">
          <ol
            aria-label={t("files.breadcrumb")}
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs"
          >
            {[root?.name ?? "", ...segments].map((label, index) => {
              const path = segments.slice(0, index).join("/");
              const current = index === segments.length;
              return (
                <li key={`${index}-${label}`} className="flex shrink-0 items-center gap-0.5">
                  {index > 0 ? (
                    <ChevronRight className="size-3.5 text-fg-subtle" aria-hidden />
                  ) : null}
                  <button
                    type="button"
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "max-w-48 truncate rounded px-1.5 py-0.5 outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent",
                      current ? "font-semibold text-fg" : "text-fg-muted",
                      dropTarget === `crumb:${path}` && "ring-2 ring-accent",
                    )}
                    onClick={() => location && !current && go({ root: location.root, path })}
                    onDragOver={(event) => allowDrop(event, `crumb:${path}`)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(event) => location && drop(event, { root: location.root, path })}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-3 py-1 text-xs text-fg-muted">
          <span>
            {t("files.count", { count: entries.length })}
            {selected.size > 0 ? ` · ${t("files.selectedCount", { count: selected.size })}` : ""}
            {listing?.truncated ? ` · ${t("files.truncated")}` : ""}
            {root?.readOnly ? ` · ${t("files.readOnly")}` : ""}
          </span>
          <UploadStatus items={uploads} onClear={() => setUploads([])} />
        </div>
      </div>
      <PropertiesDialog location={properties} onClose={() => setProperties(null)} />
      <FolderIconDialog location={iconLocation} onClose={() => setIconLocation(null)} />
      <ImagePreview location={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
