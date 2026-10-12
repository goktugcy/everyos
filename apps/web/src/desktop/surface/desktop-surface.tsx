import type { DesktopItem, FileEntry } from "@everyos/shared";
import { workArea, type Point, type Rect } from "@everyos/window-manager";
import {
  AppWindow,
  ArrowDownAZ,
  ClipboardPaste,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  ImageIcon,
  Info,
  LayoutGrid,
  Palette,
  PanelsTopLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Scissors,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/errors.ts";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { AppIcon } from "../apps/app-icon.tsx";
import { IconLabel } from "../../components/ui/icon-label.tsx";
import { FolderIcon } from "../apps/files/folder-icon.tsx";
import { FolderIconDialog } from "../apps/settings/folder-icon-picker.tsx";
import { fileGlyph } from "../apps/files/icon-view.tsx";
import {
  FILES_DRAG_TYPE,
  filesApi,
  filesChanged,
  freeName,
  isFolder,
  joinPath,
  kindOf,
  nameOf,
  parentOf,
  uploadUnique,
  useFileClipboard,
  type FileLocation,
} from "../apps/files/lib.ts";
import { ImagePreview, PropertiesDialog } from "../apps/files/parts.tsx";
import { allowedApps, getApp } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";
import type { MenuEntry } from "../menus/menu-model.ts";
import { requestConfirm } from "../menus/confirm.tsx";
import { openTerminalEntries } from "../menus/terminal-entry.tsx";
import { ContextMenuArea } from "../menus/menus.tsx";
import { readFilesDrag } from "../pulse/pulse-lib.ts";
import { desktop } from "../state/controller.ts";
import {
  addShortcut,
  arrangeIcons,
  dissolveAppGroups,
  fileCell,
  moveIcon,
  reconcileFiles,
  removeItem,
  renameFilePosition,
  setIconCell,
  type IconRef,
} from "../state/desktop-ops.ts";
import {
  flushPending,
  loadPreferences,
  updatePreference,
  usePreferences,
} from "../state/preferences-store.ts";
import { useWindowManager } from "../state/window-store.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import { widgetActions } from "../widgets/actions.ts";
import { widgetUi } from "../widgets/ui-store.ts";
import { useDesktopFolder } from "./desktop-folder.ts";
import {
  cellAt,
  cellKey,
  cellRect,
  firstFreeCell,
  gridMetrics,
  placeItems,
  type Cell,
  type GridMetrics,
} from "./icon-grid.ts";
import { ICON_PIXELS } from "@everyos/theme";
import { isDesktopShortcut } from "../shortcut-keys.ts";
import {
  iconsInRect,
  moveSelection,
  selectIcon,
  selectionRect,
  type SelectionModifiers,
} from "./icon-selection.ts";

type AppItem = Extract<DesktopItem, { kind: "app" }>;

/** A shortcut, or an entry of the home's Desktop folder. */
type Icon =
  | { id: string; kind: "app"; item: AppItem; cell: Cell | null }
  | { id: string; kind: "file"; entry: FileEntry; cell: Cell | null };

const fileId = (name: string) => `file:${name}`;
const refOf = (icon: Icon): IconRef =>
  icon.kind === "app" ? { kind: "app", id: icon.item.id } : { kind: "file", name: icon.entry.name };
const sameCell = (a: Cell | undefined, b: Cell) => a?.col === b.col && a.row === b.row;

/** Images up to this size get a thumbnail instead of a glyph. */
const THUMBNAIL_BYTES = 8 * 1024 * 1024;

/** HTML drag and drop of Desktop-folder entries (into folders, Files windows, the shelf). */
interface NativeDrag {
  onDragStart: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (event: DragEvent) => void;
}

interface IconProps {
  id: string;
  cell: Cell;
  metrics: GridMetrics;
  label: string;
  glyph: ReactNode;
  selected: boolean;
  folder: boolean;
  renaming: boolean;
  renameLimit: number;
  dropTarget: boolean;
  /** Set for Desktop-folder entries; shortcuts move with the pointer instead. */
  native: NativeDrag | null;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  onOpen: (id: string) => void;
  onMove: (id: string, cell: Cell) => void;
  onRename: (id: string, name: string | null) => void;
  onKey: (event: KeyboardEvent, id: string) => void;
}

function DesktopIcon(props: IconProps) {
  const { t } = useTranslation();
  const { id, cell, metrics, label, selected, renaming, native } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const suppressClick = useRef(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  const rect = cellRect(cell, metrics);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || renaming) return;
    cancelDrag.current?.();
    if (!selected || event.ctrlKey || event.metaKey || event.shiftKey) props.onSelect(id, event);
    suppressClick.current = true;
    const element = ref.current!;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    element.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - startX;
      const dy = pointer.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = true;
      element.style.transform = `translate3d(${rect.x + dx}px, ${rect.y + dy}px, 0)`;
      element.style.zIndex = "5";
      element.style.opacity = "0.85";
    };
    const cleanup = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.style.zIndex = "";
      element.style.opacity = "";
      element.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
      cancelDrag.current = null;
    };
    const up = (pointer: PointerEvent) => {
      cleanup();
      if (pointer.type === "pointercancel") return;
      if (dragging) props.onMove(id, cellAt({ x: pointer.clientX, y: pointer.clientY }, metrics));
      else if (pointer.pointerType === "touch") props.onOpen(id);
      else if (!pointer.ctrlKey && !pointer.metaKey && !pointer.shiftKey)
        props.onSelect(id, pointer);
    };
    cancelDrag.current = cleanup;
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  return (
    <button
      ref={ref}
      type="button"
      data-desktop-item={id}
      aria-label={label}
      aria-pressed={selected}
      draggable={native !== null && !renaming}
      className={cn(
        "group absolute left-0 top-0 flex flex-col items-center gap-1.5 rounded-everyos-md p-1.5 pt-2 outline-none focus-visible:ring-2 focus-visible:ring-accent",
        native ? "touch-manipulation" : "touch-none",
        selected && "z-10",
        "hover:z-20 focus-visible:z-20",
        props.dropTarget && "bg-[rgb(var(--everyos-accent)/0.18)] ring-2 ring-accent",
      )}
      style={{
        transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
        width: metrics.cellWidth - 6,
      }}
      onPointerDown={native ? undefined : onPointerDown}
      onDragStart={native?.onDragStart}
      onDragOver={native?.onDragOver}
      onDragLeave={native?.onDragLeave}
      onDrop={native?.onDrop}
      onClick={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        props.onSelect(id, event);
      }}
      onDoubleClick={() => props.onOpen(id)}
      onKeyDown={(event) => props.onKey(event, id)}
    >
      <span
        className={cn(
          "grid place-items-center rounded-everyos-md",
          selected && "bg-hover/20 ring-1 ring-accent/40",
        )}
      >
        {props.glyph}
      </span>
      {renaming ? (
        <input
          autoFocus
          defaultValue={label}
          maxLength={props.renameLimit}
          aria-label={t("common.rename")}
          className="glass-inset w-full rounded px-1 text-center text-xs text-fg outline-none"
          onFocus={(event) => {
            // Like Finder: the name is selected without its extension.
            const dot = label.lastIndexOf(".");
            event.currentTarget.setSelectionRange(0, native && dot > 0 ? dot : label.length);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") props.onRename(id, event.currentTarget.value);
            if (event.key === "Escape") props.onRename(id, null);
          }}
          onBlur={(event) => props.onRename(id, event.currentTarget.value)}
        />
      ) : (
        <IconLabel text={label} className="everyos-icon-label" />
      )}
    </button>
  );
}

/** A Desktop-folder entry at desktop icon size: a folder, a document sheet or a thumbnail. */
function FileGlyph({
  entry,
  size,
  thumbnail,
  location,
}: {
  entry: FileEntry;
  size: number;
  thumbnail: string | null;
  location: FileLocation;
}) {
  if (isFolder(entry)) return <FolderIcon location={location} size={size} />;
  if (thumbnail)
    return (
      <span className="grid place-items-center" style={{ width: size, height: size }}>
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          draggable={false}
          className="max-h-full min-h-6 max-w-full min-w-6 rounded-sm object-contain shadow-md ring-1 ring-black/15"
        />
      </span>
    );
  return createElement(fileGlyph(entry), {
    "aria-hidden": true,
    strokeWidth: 1.1,
    style: {
      width: size,
      height: size,
      filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.35))",
      ...(isFolder(entry)
        ? { color: "rgb(var(--everyos-accent))", fill: "rgb(var(--everyos-accent) / 0.45)" }
        : { color: "rgb(71 85 105)", fill: "rgb(255 255 255 / 0.92)" }),
    },
  });
}

/**
 * The desktop: shortcuts of the active virtual desktop and, like macOS, the
 * contents of the home's Desktop folder (on every virtual desktop), plus the
 * desktop context menu.
 */
export function DesktopSurface() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const desktopDoc = usePreferences((state) => state.desktop);
  const pinned = usePreferences((state) => state.dock.pinned);
  const iconSizeName = useThemeStore((state) => state.theme.iconSize);
  const viewport = useWindowManager((state) => state.viewport);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const folder = useDesktopFolder();
  const clipboard = useFileClipboard();
  const [selection, setSelection] = useState<{ desktopId: string; ids: ReadonlySet<string> }>({
    desktopId: activeDesktopId,
    ids: new Set(),
  });
  const selected = selection.desktopId === activeDesktopId ? selection.ids : new Set<string>();
  const setSelected = (ids: ReadonlySet<string>) =>
    setSelection({ desktopId: activeDesktopId, ids });
  const anchor = useRef<string | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const selecting = useRef<{
    pointerId: number;
    start: Point;
    bounds: Map<string, Rect>;
    initial: ReadonlySet<string>;
    additive: boolean;
    toggle: boolean;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [preview, setPreview] = useState<FileLocation | null>(null);
  const [properties, setProperties] = useState<FileLocation | null>(null);
  const [iconLocation, setIconLocation] = useState<FileLocation | null>(null);
  const menuPoint = useRef<Point | null>(null);
  const location = folder.location;
  const writable = folder.writable && location !== null;
  const iconSize = ICON_PIXELS[iconSizeName];

  const metrics = useMemo(
    () => gridMetrics(iconSizeName, workArea(viewport)),
    [iconSizeName, viewport],
  );
  const allowed = useMemo(
    () => new Set<string>(allowedApps(permissions, { includeHidden: true }).map((app) => app.id)),
    [permissions],
  );
  const icons = useMemo<Icon[]>(
    () => [
      ...desktopDoc.items
        .filter(
          (item): item is AppItem =>
            item.kind === "app" &&
            item.desktopId === activeDesktopId &&
            item.folderId === null &&
            getApp(item.appId) !== undefined &&
            allowed.has(item.appId),
        )
        .map((item) => ({ id: item.id, kind: "app" as const, item, cell: item.cell })),
      ...folder.entries.map((entry) => ({
        id: fileId(entry.name),
        kind: "file" as const,
        entry,
        cell: fileCell(desktopDoc, entry.name),
      })),
    ],
    [desktopDoc, activeDesktopId, allowed, folder.entries],
  );
  const placed = useMemo(
    () => placeItems(icons, metrics, (icon) => icon.kind === "file"),
    [icons, metrics],
  );
  const selectedCount = icons.filter((icon) => selected.has(icon.id)).length;
  const names = useMemo(() => new Set(folder.entries.map((entry) => entry.name)), [folder.entries]);

  // New entries keep the place they first appeared in; places of removed ones are forgotten.
  useEffect(() => {
    if (folder.status !== "ready") return;
    const shown = new Map<string, Cell>();
    for (const entry of folder.entries) {
      const cell = placed.get(fileId(entry.name));
      if (cell) shown.set(entry.name, cell);
    }
    const current = usePreferences.getState().desktop;
    if (reconcileFiles(current, names, shown) !== current)
      updatePreference("desktop", (doc) => reconcileFiles(doc, names, shown));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new listing arrives
  }, [folder.entries, folder.status]);

  // App groups from earlier versions become real folders in the Desktop folder.
  const legacy = desktopDoc.items.some(
    (item) => item.kind === "folder" || (item.kind === "app" && item.folderId !== null),
  );
  const migrating = useRef(false);
  useEffect(() => {
    if (!legacy || folder.status === "loading" || migrating.current) return;
    migrating.current = true;
    const into = folder.writable ? folder.location : null;
    const groups = usePreferences
      .getState()
      .desktop.items.filter((item) => item.kind === "folder")
      .map((item) => (item as { name: string }).name);
    void (async () => {
      if (into) await Promise.allSettled(groups.map((name) => filesApi.mkdir(into, name)));
      updatePreference("desktop", (doc) => dissolveAppGroups(doc, into !== null));
      if (into) filesChanged();
      migrating.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the folder is known
  }, [legacy, folder.status]);

  useEffect(() => {
    if (!notice?.error) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const labelOf = (icon: Icon): string => {
    if (icon.kind === "file") return icon.entry.name;
    const manifest = getApp(icon.item.appId);
    return manifest ? t(manifest.titleKey) : icon.item.appId;
  };

  /* ------------------------------ file actions ------------------------------ */

  const entryLocation = (name: string, base = location): FileLocation => ({
    root: base!.root,
    path: joinPath(base!.path, name),
  });

  /** Runs a file operation; every change is announced so Files windows list again too. */
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (caught) {
      setNotice({ text: errorMessage(t, caught), error: true });
      return false;
    } finally {
      filesChanged();
    }
  };

  /** The cell under the pointer when it is free, else the next free one from the right. */
  const freeCellNear = (point: Point | null): Cell => {
    const occupied = new Set([...placed.values()].map(cellKey));
    const cell = point ? cellAt(point, metrics) : null;
    return cell && !occupied.has(cellKey(cell)) ? cell : firstFreeCell(occupied, metrics, true);
  };

  const download = (target: FileLocation) => {
    const link = document.createElement("a");
    link.href = filesApi.downloadUrl(target);
    link.download = nameOf(target.path);
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  };

  const openEntry = (entry: FileEntry) => {
    if (!location) return;
    const target = entryLocation(entry.name);
    const kind = kindOf(entry);
    // Folders open in a Files window, with the sidebar, like every other folder.
    if (kind === "folder")
      desktop.openApp("everyos.files", { newInstance: true, appState: target });
    else if (kind === "image") setPreview(target);
    else if (kind === "text") desktop.openWindow("everyos.editor", target);
    else download(target);
  };

  const openIcon = (icon: Icon) => {
    if (icon.kind === "app") desktop.openApp(icon.item.appId as AppId);
    else openEntry(icon.entry);
  };

  const openDesktopFolder = () => {
    if (location) desktop.openApp("everyos.files", { newInstance: true, appState: location });
  };

  const create = async (kind: "folder" | "file") => {
    if (!location) return;
    const name = freeName(
      t(kind === "folder" ? "files.newFolderName" : "files.newFileName"),
      names,
    );
    const cell = freeCellNear(menuPoint.current);
    const done = await act(() =>
      kind === "folder"
        ? filesApi.mkdir(location, name)
        : filesApi.writeText(entryLocation(name), "", null),
    );
    if (!done) return;
    updatePreference("desktop", (doc) => setIconCell(doc, { kind: "file", name }, cell));
    setSelected(new Set([fileId(name)]));
    setRenaming(fileId(name));
  };

  const commitRename = async (id: string, value: string | null) => {
    setRenaming(null);
    const icon = icons.find((candidate) => candidate.id === id);
    if (value === null || icon?.kind !== "file" || !location) return;
    const from = icon.entry.name;
    const name = value.trim();
    if (!name || name === from) return;
    if (await act(() => filesApi.rename(entryLocation(from), name))) {
      updatePreference("desktop", (doc) => renameFilePosition(doc, from, name));
      setSelected(new Set([fileId(name)]));
    }
  };

  const selectedFor = (id: string) =>
    selected.has(id)
      ? icons.filter((icon) => selected.has(icon.id))
      : icons.filter((icon) => icon.id === id);

  const removeIcons = async (targets: Icon[]) => {
    const entries = targets
      .filter((icon): icon is Extract<Icon, { kind: "file" }> => icon.kind === "file")
      .map((icon) => icon.entry);
    if (entries.length === 0) {
      updatePreference("desktop", (doc) =>
        targets.reduce((next, icon) => removeItem(next, icon.id), doc),
      );
      setSelected(new Set());
      return;
    }
    if (!location) return;
    const ok = await requestConfirm({
      title: t("files.deleteConfirm.title", { count: entries.length }),
      body:
        entries.length === 1
          ? t("files.deleteConfirm.one", { name: entries[0]!.name })
          : t("files.deleteConfirm.many", { count: entries.length }),
      confirmLabel: t("files.deleteConfirm.confirm"),
      danger: true,
    });
    if (
      ok &&
      (await act(() =>
        filesApi.remove(
          location.root,
          entries.map((entry) => entryLocation(entry.name).path),
        ),
      ))
    ) {
      updatePreference("desktop", (doc) =>
        targets
          .filter((icon) => icon.kind === "app")
          .reduce((next, icon) => removeItem(next, icon.id), doc),
      );
      setSelected(new Set());
    }
  };

  const remove = (entry: FileEntry) => removeIcons(selectedFor(fileId(entry.name)));

  const toClipboard = (entry: FileEntry, mode: "copy" | "cut") => {
    if (!location) return;
    useFileClipboard.setState(
      {
        mode,
        root: location.root,
        paths: selectedFor(fileId(entry.name))
          .filter((icon): icon is Extract<Icon, { kind: "file" }> => icon.kind === "file")
          .map((icon) => entryLocation(icon.entry.name).path),
      },
      true,
    );
  };

  const paste = async (into: FileLocation | null = location) => {
    if (!into || !clipboard) return;
    const done = await act(() =>
      clipboard.mode === "cut"
        ? filesApi.move(clipboard.root, clipboard.paths, into)
        : filesApi.copy(clipboard.root, clipboard.paths, into),
    );
    if (done && clipboard.mode === "cut") useFileClipboard.setState(null, true);
  };

  /** Keeps the first dropped entry where it was dropped (when that cell is free). */
  const placeDropped = (name: string | undefined, cell: Cell) => {
    if (!name || icons.some((icon) => sameCell(placed.get(icon.id), cell))) return;
    updatePreference("desktop", (doc) => setIconCell(doc, { kind: "file", name }, cell));
  };

  const upload = async (files: File[], into: FileLocation, cell: Cell | null) => {
    let first: string | undefined;
    try {
      for (const file of files) {
        const progress = (loaded: number, total: number) =>
          setNotice({
            text: t("desktop.uploading", {
              name: file.name,
              percent: total ? Math.round((loaded / total) * 100) : 0,
            }),
            error: false,
          });
        progress(0, file.size);
        const name = await uploadUnique(into, file, progress);
        first ??= name;
      }
      setNotice(null);
    } catch (caught) {
      setNotice({ text: errorMessage(t, caught), error: true });
    } finally {
      if (cell) placeDropped(first, cell);
      filesChanged();
    }
  };

  /* ------------------------------ drag and drop ------------------------------ */

  const accept = (event: DragEvent, target: string) => {
    if (!writable) return false;
    const types = [...event.dataTransfer.types];
    if (!types.includes(FILES_DRAG_TYPE) && !types.includes("Files")) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect =
      types.includes("Files") || event.altKey || event.ctrlKey ? "copy" : "move";
    setDropTarget(target);
    return true;
  };

  /** Files from the computer (folders cannot be uploaded from a browser). */
  const computerFiles = (event: DragEvent) =>
    [...event.dataTransfer.items]
      .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

  /** A drop onto a folder icon: into that folder. */
  const dropInto = (event: DragEvent, into: FileLocation) => {
    event.preventDefault();
    setDropTarget(null);
    const data = readFilesDrag(event.dataTransfer.getData(FILES_DRAG_TYPE));
    if (data) {
      const inside = data.paths.some(
        (path) =>
          data.root === into.root && (into.path === path || into.path.startsWith(`${path}/`)),
      );
      const moving = data.paths.filter((path) => parentOf(path) !== into.path);
      if (inside || moving.length === 0) return;
      const copy = event.altKey || event.ctrlKey;
      void act(() =>
        copy ? filesApi.copy(data.root, moving, into) : filesApi.move(data.root, moving, into),
      );
    } else {
      const files = computerFiles(event);
      if (files.length) void upload(files, into, null);
    }
  };

  /** A drop onto the desktop: rearranges its own entries, moves or uploads others into it. */
  const dropOnDesktop = (event: DragEvent) => {
    setDropTarget(null);
    // Handled by a folder icon underneath.
    if (event.nativeEvent.defaultPrevented || !writable || !location) return;
    event.preventDefault();
    const cell = cellAt({ x: event.clientX, y: event.clientY }, metrics);
    const data = readFilesDrag(event.dataTransfer.getData(FILES_DRAG_TYPE));
    if (data) {
      const own =
        data.root === location.root && data.paths.every((path) => parentOf(path) === location.path);
      if (own) {
        const id = fileId(nameOf(data.paths[0]!));
        const moving = icons.find((icon) => icon.id === id);
        if (!moving) return;
        if (data.paths.length > 1) {
          moveGroup(new Set(data.paths.map((path) => fileId(nameOf(path)))), id, cell);
          return;
        }
        const occupant = icons.find(
          (icon) => icon.id !== id && sameCell(placed.get(icon.id), cell),
        );
        updatePreference("desktop", (doc) =>
          moveIcon(
            doc,
            refOf(moving),
            cell,
            placed.get(id) ?? null,
            occupant ? refOf(occupant) : null,
          ),
        );
        return;
      }
      const copy = event.altKey || event.ctrlKey;
      void act(async () => {
        await (copy
          ? filesApi.copy(data.root, data.paths, location)
          : filesApi.move(data.root, data.paths, location));
        placeDropped(nameOf(data.paths[0]!), cell);
      });
      return;
    }
    const files = computerFiles(event);
    if (files.length) void upload(files, location, cell);
  };

  const nativeFor = (icon: Extract<Icon, { kind: "file" }>): NativeDrag => {
    const target = entryLocation(icon.entry.name);
    return {
      onDragStart: (event) => {
        const targets = selectedFor(icon.id).filter(
          (target): target is Extract<Icon, { kind: "file" }> => target.kind === "file",
        );
        if (!selected.has(icon.id)) setSelected(new Set([icon.id]));
        event.dataTransfer.setData(
          FILES_DRAG_TYPE,
          JSON.stringify({
            root: target.root,
            paths: targets.map((entry) => entryLocation(entry.entry.name).path),
          }),
        );
        event.dataTransfer.effectAllowed = "copyMove";
      },
      ...(isFolder(icon.entry) && writable
        ? {
            onDragOver: (event: DragEvent) => {
              if (accept(event, icon.id)) event.stopPropagation();
            },
            onDragLeave: () => setDropTarget(null),
            onDrop: (event: DragEvent) => dropInto(event, target),
          }
        : {}),
    };
  };

  /* --------------------------------- icons --------------------------------- */

  const moveGroup = (ids: ReadonlySet<string>, id: string, cell: Cell) => {
    const positions = moveSelection(ids, id, cell, placed, metrics);
    if (!positions) return;
    updatePreference("desktop", (doc) =>
      icons.reduce((next, icon) => {
        const position = positions.get(icon.id);
        return position ? setIconCell(next, refOf(icon), position) : next;
      }, doc),
    );
  };

  const onSelect = (id: string, modifiers: SelectionModifiers) => {
    const order = [...placed]
      .sort(([, a], [, b]) => a.col - b.col || a.row - b.row)
      .map(([key]) => key);
    setSelected(selectIcon(selected, id, order, anchor.current, modifiers));
    if (!modifiers.shiftKey) anchor.current = id;
  };

  const onMove = (id: string, cell: Cell) => {
    const moving = icons.find((icon) => icon.id === id);
    if (!moving) return;
    if (selected.has(id) && selected.size > 1) {
      moveGroup(selected, id, cell);
      return;
    }
    const occupant = icons.find((icon) => icon.id !== id && sameCell(placed.get(icon.id), cell));
    updatePreference("desktop", (doc) =>
      moveIcon(doc, refOf(moving), cell, placed.get(id) ?? null, occupant ? refOf(occupant) : null),
    );
  };

  const onKey = (event: KeyboardEvent, id: string) => {
    if (isDesktopShortcut(event)) return;
    const icon = icons.find((candidate) => candidate.id === id);
    if (!icon) return;
    const mod = event.metaKey || event.ctrlKey;
    const file = icon.kind === "file" ? icon.entry : null;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(icons.map((item) => item.id)));
    } else if (event.key === "Escape") {
      setSelected(new Set());
      setRenaming(null);
    } else if (event.key === "Enter") selectedFor(id).forEach(openIcon);
    else if (event.key === "F2" && file && writable && selected.size <= 1) setRenaming(id);
    else if (file && writable && (event.key === "Delete" || (event.key === "Backspace" && mod))) {
      event.preventDefault();
      void remove(file);
    } else if (!file && (event.key === "Delete" || (event.key === "Backspace" && mod))) {
      event.preventDefault();
      void removeIcons(selectedFor(id));
    } else if (file && mod && event.key.toLowerCase() === "c") toClipboard(file, "copy");
    else if (file && writable && mod && event.key.toLowerCase() === "x") toClipboard(file, "cut");
    else if (mod && writable && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void paste();
    } else navigate(event, id);
  };

  const navigate = (event: KeyboardEvent, id: string) => {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const delta = deltas[event.key];
    const from = placed.get(id);
    if (!delta || !from) return;
    event.preventDefault();
    // Nearest icon in the pressed direction.
    let best: { id: string; distance: number } | null = null;
    for (const [otherId, cell] of placed) {
      const dx = cell.col - from.col;
      const dy = cell.row - from.row;
      if (
        otherId === id ||
        (Math.sign(dx) !== delta[0] && delta[0] !== 0) ||
        (Math.sign(dy) !== delta[1] && delta[1] !== 0)
      )
        continue;
      if ((delta[0] !== 0 && dx === 0) || (delta[1] !== 0 && dy === 0)) continue;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (!best || distance < best.distance) best = { id: otherId, distance };
    }
    if (best) {
      onSelect(best.id, event);
      document.querySelector<HTMLElement>(`[data-desktop-item="${CSS.escape(best.id)}"]`)?.focus();
    }
  };

  const arrange = (by: "name" | "kind") =>
    updatePreference("desktop", (doc) =>
      arrangeIcons(
        doc,
        icons.map((icon) => ({
          ref: refOf(icon),
          name: labelOf(icon),
          group: icon.kind === "app" ? 1 : isFolder(icon.entry) ? 0 : 2,
        })),
        by,
        metrics,
      ),
    );

  /* --------------------------------- menus --------------------------------- */

  const desktopMenu = (): MenuEntry[] => {
    const onThisDesktop = new Set(
      icons.flatMap((icon) => (icon.kind === "app" ? [icon.item.appId] : [])),
    );
    const addable = allowedApps(permissions).filter((app) => !onThisDesktop.has(app.id));
    const fileEntries: MenuEntry[] = writable
      ? [
          {
            kind: "item",
            id: "new-folder",
            label: t("desktop.menu.newFolder"),
            icon: <FolderPlus />,
            onSelect: () => void create("folder"),
          },
          {
            kind: "item",
            id: "new-file",
            label: t("files.menu.newFile"),
            icon: <FilePlus2 />,
            onSelect: () => void create("file"),
          },
          {
            kind: "item",
            id: "paste",
            label: t("files.menu.paste"),
            icon: <ClipboardPaste />,
            disabled: !clipboard,
            onSelect: () => void paste(),
          },
        ]
      : [];
    return [
      ...fileEntries,
      {
        kind: "item",
        id: "trash",
        label: t("apps.trash"),
        icon: <Trash2 />,
        disabled: !permissions.includes("files:read"),
        onSelect: () => desktop.openApp("everyos.trash"),
      },
      {
        kind: "submenu",
        id: "add-shortcut",
        label: t("desktop.menu.addShortcut"),
        icon: <Plus />,
        entries:
          addable.length > 0
            ? addable.map((app) => ({
                kind: "item" as const,
                id: app.id,
                label: t(app.titleKey),
                onSelect: () =>
                  updatePreference("desktop", (doc) =>
                    addShortcut(doc, app.id, activeDesktopId, metrics),
                  ),
              }))
            : [{ kind: "label" as const, id: "none", label: t("desktop.menu.noShortcutsLeft") }],
      },
      ...(location
        ? [
            {
              kind: "item" as const,
              id: "open-folder",
              label: t("desktop.menu.openDesktopFolder"),
              icon: <FolderOpen />,
              onSelect: openDesktopFolder,
            },
          ]
        : []),
      ...openTerminalEntries(t("desktop.menu.openTerminal"), permissions),
      { kind: "separator", id: "s0" },
      {
        kind: "item",
        id: "add-widget",
        label: t("widgets.menu.addWidget"),
        icon: <PanelsTopLeft />,
        onSelect: () => widgetUi.openGallery("desktop"),
      },
      {
        kind: "check",
        id: "widget-sidebar",
        label: t("widgets.sidebar.label"),
        checked: usePreferences.getState().widgets.sidebar.open,
        onCheckedChange: (open) => widgetActions.setSidebar(open),
      },
      { kind: "separator", id: "s1" },
      {
        kind: "item",
        id: "wallpaper",
        label: t("desktop.menu.changeWallpaper"),
        icon: <ImageIcon />,
        onSelect: () => desktop.openSettings("appearance"),
      },
      {
        kind: "item",
        id: "personalize",
        label: t("desktop.menu.personalize"),
        icon: <Palette />,
        onSelect: () => desktop.openSettings("appearance"),
      },
      {
        kind: "submenu",
        id: "arrange",
        label: t("desktop.menu.arrangeIcons"),
        icon: <LayoutGrid />,
        entries: [
          {
            kind: "item",
            id: "name",
            label: t("desktop.menu.arrangeByName"),
            icon: <ArrowDownAZ />,
            onSelect: () => arrange("name"),
          },
          {
            kind: "item",
            id: "kind",
            label: t("desktop.menu.arrangeByKind"),
            icon: <LayoutGrid />,
            onSelect: () => arrange("kind"),
          },
        ],
      },
      {
        kind: "item",
        id: "refresh",
        label: t("desktop.menu.refresh"),
        icon: <RefreshCw />,
        onSelect: () => {
          filesChanged();
          void flushPending()
            .then(() => loadPreferences({ t, permissions }))
            .catch(() => usePreferences.setState({ saveError: true }));
        },
      },
      { kind: "separator", id: "s2" },
      {
        kind: "item",
        id: "settings",
        label: t("desktop.menu.desktopSettings"),
        icon: <Settings2 />,
        onSelect: () => desktop.openSettings("desktop"),
      },
    ];
  };

  const fileMenu = (entry: FileEntry): MenuEntry[] => {
    const target = entryLocation(entry.name);
    const folderEntry = isFolder(entry);
    return [
      {
        kind: "item",
        id: "open",
        label: t("files.menu.open"),
        icon: <FolderOpen />,
        onSelect: () => openEntry(entry),
      },
      ...(!folderEntry && kindOf(entry) !== "link"
        ? [
            {
              kind: "item" as const,
              id: "download",
              label: t("files.menu.download"),
              icon: <Download />,
              onSelect: () => download(target),
            },
          ]
        : []),
      {
        kind: "item",
        id: "show",
        label: t("desktop.menu.showInFiles"),
        icon: <AppWindow />,
        onSelect: openDesktopFolder,
      },
      { kind: "separator", id: "s1" },
      {
        kind: "item",
        id: "cut",
        label: t("files.menu.cut"),
        icon: <Scissors />,
        shortcut: "Ctrl+X",
        disabled: !writable,
        onSelect: () => toClipboard(entry, "cut"),
      },
      {
        kind: "item",
        id: "copy",
        label: t("files.menu.copy"),
        icon: <Copy />,
        shortcut: "Ctrl+C",
        onSelect: () => toClipboard(entry, "copy"),
      },
      ...(folderEntry
        ? [
            {
              kind: "item" as const,
              id: "paste",
              label: t("files.menu.pasteInto"),
              icon: <ClipboardPaste />,
              disabled: !writable || !clipboard,
              onSelect: () => void paste(target),
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
        disabled: !writable,
        onSelect: () => setRenaming(fileId(entry.name)),
      },
      ...(folderEntry && permissions.includes("preferences:manage")
        ? [
            {
              kind: "item" as const,
              id: "folder-icon",
              label: t("folderIcons.change"),
              icon: <Palette />,
              onSelect: () => setIconLocation(target),
            },
          ]
        : []),
      {
        kind: "item",
        id: "properties",
        label: t("files.menu.properties"),
        icon: <Info />,
        onSelect: () => setProperties(target),
      },
      { kind: "separator", id: "s3" },
      {
        kind: "item",
        id: "delete",
        label: t("files.menu.delete"),
        icon: <Trash2 />,
        danger: true,
        disabled: !writable,
        onSelect: () => void remove(entry),
      },
    ];
  };

  const appMenu = (item: AppItem): MenuEntry[] => {
    const manifest = getApp(item.appId);
    const isPinned = pinned.includes(item.appId);
    return [
      {
        kind: "item",
        id: "open",
        label: t("desktop.menu.open"),
        icon: <AppWindow />,
        onSelect: () => desktop.openApp(item.appId as AppId),
      },
      ...(manifest?.window.instancing === "multiple"
        ? [
            {
              kind: "item" as const,
              id: "new",
              label: t("desktop.menu.newWindow"),
              onSelect: () => desktop.openWindow(item.appId as AppId),
            },
          ]
        : []),
      { kind: "separator", id: "s1" },
      {
        kind: "item",
        id: "pin",
        label: isPinned ? t("desktop.menu.unpinFromDock") : t("desktop.menu.pinToDock"),
        icon: isPinned ? <PinOff /> : <Pin />,
        onSelect: () =>
          updatePreference("dock", (dock) => ({
            ...dock,
            pinned: isPinned
              ? dock.pinned.filter((id) => id !== item.appId)
              : [...dock.pinned, item.appId],
          })),
      },
      { kind: "separator", id: "s2" },
      {
        kind: "item",
        id: "remove",
        label: t("desktop.menu.removeShortcut"),
        icon: <Trash2 />,
        onSelect: () => updatePreference("desktop", (doc) => removeItem(doc, item.id)),
      },
    ];
  };

  const glyphOf = (icon: Icon): ReactNode => {
    if (icon.kind === "app") {
      const manifest = getApp(icon.item.appId);
      return manifest ? <AppIcon manifest={manifest} size={iconSize} /> : null;
    }
    const thumbnail =
      location && kindOf(icon.entry) === "image" && icon.entry.size <= THUMBNAIL_BYTES
        ? filesApi.downloadUrl(entryLocation(icon.entry.name), true)
        : null;
    return (
      <FileGlyph
        entry={icon.entry}
        size={iconSize}
        thumbnail={thumbnail}
        location={entryLocation(icon.entry.name)}
      />
    );
  };

  const groupMenu = (icon: Icon): MenuEntry[] => {
    const targets = selectedFor(icon.id);
    if (targets.length < 2) return icon.kind === "app" ? appMenu(icon.item) : fileMenu(icon.entry);
    const files = targets.filter(
      (item): item is Extract<Icon, { kind: "file" }> => item.kind === "file",
    );
    return [
      {
        kind: "item",
        id: "open",
        label: t("desktop.menu.open"),
        icon: <FolderOpen />,
        onSelect: () => targets.forEach(openIcon),
      },
      {
        kind: "item",
        id: "copy",
        label: t("files.menu.copy"),
        icon: <Copy />,
        disabled: files.length !== targets.length,
        onSelect: () => files[0] && toClipboard(files[0].entry, "copy"),
      },
      {
        kind: "item",
        id: "cut",
        label: t("files.menu.cut"),
        icon: <Scissors />,
        disabled: !writable || files.length !== targets.length,
        onSelect: () => files[0] && toClipboard(files[0].entry, "cut"),
      },
      { kind: "separator", id: "s1" },
      {
        kind: "item",
        id: "remove",
        label: files.length ? t("files.menu.delete") : t("desktop.menu.removeShortcut"),
        icon: <Trash2 />,
        disabled: files.length > 0 && !writable,
        onSelect: () => void removeIcons(targets),
      },
    ];
  };

  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget || event.pointerType === "touch")
      return;
    event.preventDefault();
    event.currentTarget.focus();
    const bounds = new Map<string, Rect>();
    event.currentTarget.querySelectorAll<HTMLElement>("[data-desktop-item]").forEach((element) => {
      const rect = element.getBoundingClientRect();
      bounds.set(element.dataset.desktopItem!, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    });
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    selecting.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      initial: selected,
      bounds,
      additive,
      toggle: event.ctrlKey || event.metaKey,
    };
    if (!additive) setSelected(new Set());
    setRenaming(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const extendSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selecting.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = selectionRect(drag.start, { x: event.clientX, y: event.clientY });
    const hit = iconsInRect(rect, drag.bounds);
    const next = new Set(drag.additive ? drag.initial : []);
    for (const id of hit) {
      if (drag.toggle && next.has(id)) next.delete(id);
      else next.add(id);
    }
    setSelected(next);
    const surface = event.currentTarget.getBoundingClientRect();
    setMarquee({ ...rect, x: rect.x - surface.x, y: rect.y - surface.y });
  };

  const endSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selecting.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.type === "pointercancel") setSelected(drag.initial);
    selecting.current = null;
    setMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      <ContextMenuArea entries={desktopMenu}>
        <div
          className={cn(
            "absolute inset-0 z-10",
            dropTarget === "desktop" && "bg-[rgb(var(--everyos-accent)/0.05)]",
          )}
          role="group"
          aria-label={t("desktop.workspace")}
          data-testid="desktop-surface"
          tabIndex={0}
          onPointerDown={beginSelection}
          onPointerMove={extendSelection}
          onPointerUp={endSelection}
          onPointerCancel={endSelection}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && writable) {
              event.preventDefault();
              void paste();
              return;
            }
            const id = [...selected][0] ?? icons[0]?.id;
            if (id) onKey(event, id);
          }}
          onContextMenu={(event) => {
            menuPoint.current = { x: event.clientX, y: event.clientY };
          }}
          onDragOver={(event) => accept(event, "desktop")}
          onDragLeave={(event) => {
            if (event.target === event.currentTarget) setDropTarget(null);
          }}
          onDrop={dropOnDesktop}
        >
          {icons.map((icon) => {
            const cell = placed.get(icon.id);
            const glyph = glyphOf(icon);
            if (!cell || !glyph) return null;
            return (
              <ContextMenuArea key={icon.id} entries={() => groupMenu(icon)}>
                <div
                  className="contents"
                  onContextMenu={() => {
                    if (!selected.has(icon.id)) setSelected(new Set([icon.id]));
                  }}
                >
                  <DesktopIcon
                    id={icon.id}
                    cell={cell}
                    metrics={metrics}
                    label={labelOf(icon)}
                    glyph={glyph}
                    selected={selected.has(icon.id)}
                    folder={icon.kind === "file" && isFolder(icon.entry)}
                    renaming={renaming === icon.id}
                    renameLimit={icon.kind === "file" ? 255 : 40}
                    dropTarget={dropTarget === icon.id}
                    native={icon.kind === "file" ? nativeFor(icon) : null}
                    onSelect={onSelect}
                    onOpen={(id) => {
                      const target = icons.find((candidate) => candidate.id === id);
                      if (target) openIcon(target);
                    }}
                    onMove={onMove}
                    onRename={(id, name) => void commitRename(id, name)}
                    onKey={onKey}
                  />
                </div>
              </ContextMenuArea>
            );
          })}
          {marquee ? (
            <div
              aria-hidden
              data-testid="desktop-selection-area"
              className="pointer-events-none absolute z-20 rounded-sm border border-accent bg-accent/15"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          ) : null}
          {selectedCount > 1 ? (
            <span
              role="status"
              className="pointer-events-none absolute bottom-24 left-4 rounded-everyos-md bg-surface/80 px-3 py-2 text-xs text-fg"
            >
              {t("desktop.selectedCount", { count: selectedCount })}
            </span>
          ) : null}
          {notice ? (
            <div
              role={notice.error ? "alert" : "status"}
              className="glass-strong absolute bottom-24 left-4 flex max-w-sm items-start gap-2 rounded-everyos-md px-3 py-2 text-xs text-fg shadow-lg"
            >
              <span className={cn("min-w-0 flex-1", notice.error && "text-danger")}>
                {notice.text}
              </span>
              <button
                type="button"
                aria-label={t("common.close")}
                className="grid size-4 shrink-0 place-items-center rounded text-fg-muted hover:text-fg"
                onClick={() => setNotice(null)}
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      </ContextMenuArea>
      <ImagePreview location={preview} onClose={() => setPreview(null)} />
      <PropertiesDialog location={properties} onClose={() => setProperties(null)} />
      <FolderIconDialog location={iconLocation} onClose={() => setIconLocation(null)} />
    </>
  );
}
