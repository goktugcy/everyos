import type { DesktopItem } from "@otuken/shared";
import { workArea } from "@otuken/window-manager";
import {
  AppWindow,
  ArrowDownAZ,
  FolderOpen,
  FolderPlus,
  ImageIcon,
  LayoutGrid,
  Palette,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Pencil,
  FolderInput,
  PanelsTopLeft,
} from "lucide-react";
import {
  memo,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { AppIcon } from "../apps/app-icon.tsx";
import { allowedApps, getApp } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";
import type { MenuEntry } from "../menus/menu-model.ts";
import { ContextMenuArea } from "../menus/menus.tsx";
import { desktop } from "../state/controller.ts";
import {
  addShortcut,
  arrangeIcons,
  createFolder,
  deleteFolder,
  moveIntoFolder,
  moveItem,
  removeItem,
  renameFolder,
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
import {
  cellAt,
  cellRect,
  gridMetrics,
  placeItems,
  type Cell,
  type GridMetrics,
} from "./icon-grid.ts";
import { ICON_PIXELS } from "@otuken/theme";

const FOLDER_MANIFEST = getApp("otuken.folder")!;

interface IconProps {
  item: DesktopItem;
  cell: Cell;
  metrics: GridMetrics;
  label: string;
  selected: boolean;
  renaming: boolean;
  iconSize: number;
  pinned: boolean;
  onSelect: (id: string) => void;
  onOpen: (item: DesktopItem) => void;
  onDrop: (item: DesktopItem, cell: Cell) => void;
  onRename: (id: string, name: string | null) => void;
  onStartRename: (id: string) => void;
  onKeyNavigate: (event: KeyboardEvent, id: string) => void;
}

const DesktopIcon = memo(function DesktopIcon(props: IconProps) {
  const { t } = useTranslation();
  const { item, cell, metrics, label, selected, renaming, iconSize } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const manifest = item.kind === "app" ? getApp(item.appId) : FOLDER_MANIFEST;
  const rect = cellRect(cell, metrics);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || renaming) return;
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
    const up = (pointer: PointerEvent) => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.style.zIndex = "";
      element.style.opacity = "";
      element.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
      if (dragging) props.onDrop(item, cellAt({ x: pointer.clientX, y: pointer.clientY }, metrics));
      else if (pointer.pointerType === "touch") props.onOpen(item);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  if (!manifest) return null;
  return (
    <button
      ref={ref}
      type="button"
      data-desktop-item={item.id}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        "group absolute left-0 top-0 flex touch-none flex-col items-center gap-1.5 rounded-otk-md p-1.5 pt-2 outline-none focus-visible:ring-2 focus-visible:ring-accent",
        selected && "bg-hover/12",
      )}
      style={{
        transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
        width: metrics.cellWidth - 6,
      }}
      onPointerDown={onPointerDown}
      onClick={() => props.onSelect(item.id)}
      onDoubleClick={() => props.onOpen(item)}
      onKeyDown={(event) => {
        if (event.key === "Enter") props.onOpen(item);
        else if (event.key === "F2" && item.kind === "folder") props.onStartRename(item.id);
        else props.onKeyNavigate(event, item.id);
      }}
    >
      <AppIcon manifest={manifest} size={iconSize} />
      {renaming ? (
        <input
          autoFocus
          defaultValue={label}
          maxLength={40}
          aria-label={t("common.rename")}
          className="glass-inset w-full rounded px-1 text-center text-xs text-fg outline-none"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") props.onRename(item.id, event.currentTarget.value);
            if (event.key === "Escape") props.onRename(item.id, null);
          }}
          onBlur={(event) => props.onRename(item.id, event.currentTarget.value)}
        />
      ) : (
        <span
          className="line-clamp-2 max-w-full rounded-md px-1.5 py-0.5 text-center text-[0.72rem] font-medium leading-tight text-fg"
          style={{ background: "rgb(var(--otk-surface) / var(--otk-surface-opacity))" }}
        >
          {label}
        </span>
      )}
    </button>
  );
});

/**
 * The desktop: icons and folders of the active virtual desktop on a grid,
 * plus the desktop context menu.
 */
export function DesktopSurface() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const desktopDoc = usePreferences((state) => state.desktop);
  const pinned = usePreferences((state) => state.dock.pinned);
  const iconSizeName = useThemeStore((state) => state.theme.iconSize);
  const viewport = useWindowManager((state) => state.viewport);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const metrics = useMemo(
    () => gridMetrics(iconSizeName, workArea(viewport)),
    [iconSizeName, viewport],
  );
  const items = useMemo(
    () =>
      desktopDoc.items.filter(
        (item) =>
          item.desktopId === activeDesktopId &&
          (item.kind === "folder" ||
            (item.folderId === null &&
              getApp(item.appId) &&
              allowedApps(permissions, { includeHidden: true }).some((a) => a.id === item.appId))),
      ),
    [desktopDoc.items, activeDesktopId, permissions],
  );
  const placed = useMemo(() => placeItems(items, metrics), [items, metrics]);

  const nameOf = (item: DesktopItem): string => {
    if (item.kind === "folder") return item.name;
    const manifest = getApp(item.appId);
    return manifest ? t(manifest.titleKey) : item.appId;
  };

  const open = (item: DesktopItem) => {
    if (item.kind === "folder") desktop.openWindow("otuken.folder", { folderId: item.id });
    else desktop.openApp(item.appId as AppId);
  };

  const onDrop = (item: DesktopItem, cell: Cell) => {
    const target = items.find(
      (other) =>
        other.id !== item.id &&
        placed.get(other.id)?.col === cell.col &&
        placed.get(other.id)?.row === cell.row,
    );
    if (target?.kind === "folder" && item.kind === "app") {
      updatePreference("desktop", (doc) => moveIntoFolder(doc, item.id, target.id));
    } else {
      updatePreference("desktop", (doc) => moveItem(doc, item.id, cell));
    }
  };

  const onRename = (id: string, name: string | null) => {
    setRenaming(null);
    if (name !== null) updatePreference("desktop", (doc) => renameFolder(doc, id, name));
  };

  const onKeyNavigate = (event: KeyboardEvent, id: string) => {
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
      setSelected(best.id);
      document.querySelector<HTMLElement>(`[data-desktop-item="${best.id}"]`)?.focus();
    }
  };

  const desktopMenu = (): MenuEntry[] => {
    const onThisDesktop = new Set(
      items.filter((item) => item.kind === "app").map((item) => (item as { appId: string }).appId),
    );
    const addable = allowedApps(permissions).filter((app) => !onThisDesktop.has(app.id));
    return [
      {
        kind: "item",
        id: "new-folder",
        label: t("desktop.menu.newFolder"),
        icon: <FolderPlus />,
        onSelect: () => {
          let created = "";
          updatePreference("desktop", (doc) => {
            const result = createFolder(doc, activeDesktopId, t("desktop.newFolderName"), metrics);
            created = result.id;
            return result.doc;
          });
          setRenaming(created);
        },
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
            onSelect: () =>
              updatePreference("desktop", (doc) =>
                arrangeIcons(doc, activeDesktopId, "name", nameOf, metrics),
              ),
          },
          {
            kind: "item",
            id: "kind",
            label: t("desktop.menu.arrangeByKind"),
            icon: <LayoutGrid />,
            onSelect: () =>
              updatePreference("desktop", (doc) =>
                arrangeIcons(doc, activeDesktopId, "kind", nameOf, metrics),
              ),
          },
        ],
      },
      {
        kind: "item",
        id: "refresh",
        label: t("desktop.menu.refresh"),
        icon: <RefreshCw />,
        onSelect: () =>
          void flushPending()
            .then(() => loadPreferences({ t, permissions }))
            .catch(() => usePreferences.setState({ saveError: true })),
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

  const itemMenu = (item: DesktopItem): MenuEntry[] => {
    if (item.kind === "folder") {
      return [
        {
          kind: "item",
          id: "open",
          label: t("desktop.menu.open"),
          icon: <FolderOpen />,
          onSelect: () => open(item),
        },
        {
          kind: "item",
          id: "rename",
          label: t("desktop.menu.rename"),
          icon: <Pencil />,
          shortcut: "F2",
          onSelect: () => setRenaming(item.id),
        },
        { kind: "separator", id: "s" },
        {
          kind: "item",
          id: "delete",
          label: t("desktop.menu.deleteFolder"),
          icon: <Trash2 />,
          danger: true,
          confirm: {
            title: t("desktop.deleteFolder.title"),
            body: t("desktop.deleteFolder.body", { name: item.name }),
            confirmLabel: t("desktop.deleteFolder.confirm"),
          },
          onSelect: () => updatePreference("desktop", (doc) => deleteFolder(doc, item.id, metrics)),
        },
      ];
    }
    const manifest = getApp(item.appId);
    const isPinned = pinned.includes(item.appId);
    const folders = items.filter(
      (other): other is Extract<DesktopItem, { kind: "folder" }> => other.kind === "folder",
    );
    return [
      {
        kind: "item",
        id: "open",
        label: t("desktop.menu.open"),
        icon: <AppWindow />,
        onSelect: () => open(item),
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
      {
        kind: "submenu",
        id: "folder",
        label: t("desktop.menu.moveIntoFolder"),
        icon: <FolderInput />,
        disabled: folders.length === 0,
        entries: folders.map((folder) => ({
          kind: "item" as const,
          id: folder.id,
          label: folder.name,
          onSelect: () =>
            updatePreference("desktop", (doc) => moveIntoFolder(doc, item.id, folder.id)),
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

  return (
    <ContextMenuArea entries={desktopMenu}>
      <div
        className="absolute inset-0 z-10"
        role="group"
        aria-label={t("desktop.workspace")}
        data-testid="desktop-surface"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}
      >
        {items.map((item) => {
          const cell = placed.get(item.id);
          if (!cell) return null;
          return (
            <ContextMenuArea key={item.id} entries={() => itemMenu(item)}>
              <div className="contents">
                <DesktopIcon
                  item={item}
                  cell={cell}
                  metrics={metrics}
                  label={nameOf(item)}
                  selected={selected === item.id}
                  renaming={renaming === item.id}
                  iconSize={ICON_PIXELS[iconSizeName]}
                  pinned={item.kind === "app" && pinned.includes(item.appId)}
                  onSelect={setSelected}
                  onOpen={open}
                  onDrop={onDrop}
                  onRename={onRename}
                  onStartRename={setRenaming}
                  onKeyNavigate={onKeyNavigate}
                />
              </div>
            </ContextMenuArea>
          );
        })}
      </div>
    </ContextMenuArea>
  );
}
