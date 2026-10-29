import { requestClose } from "../windows/close-guards.ts";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DockPreferences } from "@everyos/shared";
import { AppWindow, LayoutGrid, MonitorUp, Pin, PinOff, XCircle } from "lucide-react";
import { Tooltip } from "radix-ui";
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { AppIcon } from "../apps/app-icon.tsx";
import { useTrashMenu } from "../apps/files/trash-menu.tsx";
import { appTitle } from "../apps/app-title.ts";
import { useInstalledApps } from "../apps/store/installed-apps-store.ts";
import { getApp, isAppAllowed } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";
import { useLauncher } from "../launcher/launcher-store.ts";
import type { MenuEntry } from "../menus/menu-model.ts";
import { ContextMenuArea } from "../menus/menus.tsx";
import { desktop } from "../state/controller.ts";
import { StorageShelf } from "./storage-shelf.tsx";
import { addShortcut } from "../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { useWindowManager, wm } from "../state/window-store.ts";
import { gridMetrics } from "../surface/icon-grid.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import { workArea } from "@everyos/window-manager";
import { useDesktopApps } from "../desktop-apps/store.ts";

interface DockWindow {
  id: string;
  appId: string;
  title: string;
  minimized: boolean;
  desktopId: string;
  z: number;
}

function useDockWindows(): DockWindow[] {
  return useWindowManager(useShallow((state) => Object.values(state.windows)));
}

/** Dock click: open, focus, or minimize the app's most recent window. */
function activateApp(appId: string, windows: DockWindow[]): void {
  const own = windows.filter((window) => window.appId === appId).sort((a, b) => b.z - a.z);
  const top = own[0];
  if (!top) {
    desktop.openApp(appId as AppId);
    return;
  }
  const state = wm();
  if (state.focusedId === top.id && !top.minimized && top.desktopId === state.activeDesktopId)
    state.minimize(top.id);
  else state.focus(top.id);
}

function WithTooltip({
  label,
  side,
  children,
}: {
  label: string;
  side: "top" | "left" | "right";
  children: ReactNode;
}) {
  return (
    <Tooltip.Root delayDuration={350}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={10}
          className="glass-strong z-[8500] rounded-everyos-sm px-2.5 py-1 text-xs font-medium text-fg"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function DockItem({
  appId,
  sortable,
  windows,
  dock,
  side,
}: {
  appId: string;
  sortable: boolean;
  windows: DockWindow[];
  dock: DockPreferences;
  side: "top" | "left" | "right";
}) {
  const { t, i18n } = useTranslation();
  const manifest = getApp(appId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: appId,
    disabled: !sortable,
  });
  const own = windows.filter((window) => window.appId === appId);
  const running = own.length > 0;
  const pinned = dock.pinned.includes(appId);
  const iconSize = useThemeStore((state) => state.theme.iconSize);
  const viewport = useWindowManager((state) => state.viewport);
  const trashMenu = useTrashMenu();
  if (!manifest) return null;
  const label = appTitle(manifest, t, i18n.language);

  const menu = (): MenuEntry[] => [
    own.length === 0 || manifest.window.instancing === "multiple"
      ? {
          kind: "item",
          id: "open",
          label: running ? t("dock.newWindow") : t("common.open"),
          icon: <AppWindow />,
          onSelect: () => desktop.openWindow(appId as AppId),
        }
      : {
          kind: "item",
          id: "open",
          label: t("common.open"),
          icon: <AppWindow />,
          onSelect: () => activateApp(appId, windows),
        },
    ...(own.length > 0
      ? [
          { kind: "separator" as const, id: "s0" },
          { kind: "label" as const, id: "windows", label: t("dock.windows") },
          ...own.map((window) => ({
            kind: "item" as const,
            id: window.id,
            label: window.title || label,
            onSelect: () => wm().focus(window.id),
          })),
        ]
      : []),
    { kind: "separator", id: "s1" },
    ...(appId === "everyos.trash"
      ? [...trashMenu(), { kind: "separator" as const, id: "trash-separator" }]
      : []),
    ...(manifest.hidden
      ? []
      : [
          {
            kind: "item" as const,
            id: "pin",
            label: pinned ? t("dock.unpin") : t("dock.pin"),
            icon: pinned ? <PinOff /> : <Pin />,
            permission: "preferences:manage" as const,
            disabled: !pinned && dock.pinned.length >= 32,
            onSelect: () =>
              updatePreference("dock", (current) => ({
                ...current,
                pinned: pinned
                  ? current.pinned.filter((id) => id !== appId)
                  : current.pinned.length < 32 && !current.pinned.includes(appId)
                    ? [...current.pinned, appId]
                    : current.pinned,
              })),
          },
          {
            kind: "item" as const,
            id: "shortcut",
            label: t("dock.addShortcut"),
            icon: <MonitorUp />,
            permission: "preferences:manage" as const,
            onSelect: () =>
              updatePreference("desktop", (doc) =>
                addShortcut(
                  doc,
                  appId,
                  wm().activeDesktopId,
                  gridMetrics(iconSize, workArea(viewport)),
                ),
              ),
          },
        ]),
    ...(running
      ? [
          {
            kind: "item" as const,
            id: "close",
            label: t("dock.closeAll"),
            icon: <XCircle />,
            onSelect: () => own.forEach((w) => void requestClose(w.id, () => wm().close(w.id))),
          },
        ]
      : []),
  ];

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
  };
  const vertical = dock.position !== "bottom";

  return (
    <ContextMenuArea entries={menu}>
      <li
        ref={setNodeRef}
        style={style}
        className="relative flex items-center justify-center"
        data-dock-item={appId}
      >
        <WithTooltip label={label} side={side}>
          <button
            type="button"
            aria-label={label}
            className="everyos-dock-button grid place-items-center rounded-everyos-md outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-accent"
            style={{
              width: dock.iconSize,
              height: dock.iconSize,
              transform: "scale(var(--dock-scale, 1))",
              transformOrigin: vertical
                ? dock.position === "left"
                  ? "left center"
                  : "right center"
                : "bottom center",
            }}
            onClick={() => activateApp(appId, windows)}
            {...(sortable ? attributes : {})}
            {...(sortable ? listeners : {})}
          >
            <AppIcon manifest={manifest} size={Math.round(dock.iconSize * 0.86)} />
          </button>
        </WithTooltip>
        {running ? (
          <span
            aria-hidden
            className={cn(
              "absolute size-1 rounded-full bg-fg",
              vertical
                ? dock.position === "left"
                  ? "-left-1.5 top-1/2 -translate-y-1/2"
                  : "-right-1.5 top-1/2 -translate-y-1/2"
                : "-bottom-1.5 left-1/2 -translate-x-1/2",
            )}
          />
        ) : null}
      </li>
    </ContextMenuArea>
  );
}

/** Traditional taskbar button for one window. */
function TaskbarWindow({ window, focused }: { window: DockWindow; focused: boolean }) {
  const { t } = useTranslation();
  const manifest = getApp(window.appId);
  if (!manifest) return null;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          const state = wm();
          if (focused && !window.minimized) state.minimize(window.id);
          else state.focus(window.id);
        }}
        className={cn(
          "flex h-9 max-w-52 items-center gap-2 rounded-everyos-sm px-2.5 text-xs font-medium",
          focused && !window.minimized ? "bg-hover/15 text-fg" : "text-fg-muted hover:bg-hover/8",
        )}
      >
        <AppIcon manifest={manifest} size={20} />
        <span className="truncate">{window.title || appTitle(manifest, t)}</span>
      </button>
    </li>
  );
}

export function Dock() {
  const { t } = useTranslation();
  useInstalledApps((state) => state.apps);
  useDesktopApps();
  const dock = usePreferences((state) => state.dock);
  const permissions = usePermissions();
  const windows = useDockWindows();
  const focusedId = useWindowManager((state) => state.focusedId);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const openLauncher = useLauncher((state) => state.open);
  const listRef = useRef<HTMLUListElement>(null);
  const [revealed, setRevealed] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const renderMode = useThemeStore((state) => state.theme.renderMode);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const pinned = dock.pinned.filter((appId) => {
    const manifest = getApp(appId);
    return manifest && isAppAllowed(manifest, permissions);
  });
  const runningExtra = useMemo(() => {
    const seen = new Set(pinned);
    const extra: string[] = [];
    for (const window of windows) {
      if (!seen.has(window.appId)) {
        seen.add(window.appId);
        extra.push(window.appId);
      }
    }
    return extra;
  }, [pinned, windows]);

  const vertical = dock.position !== "bottom";
  const side = dock.position === "bottom" ? "top" : dock.position === "left" ? "right" : "left";
  const floating = dock.style === "floating";
  const taskbar = dock.style === "taskbar";
  const magnify = dock.magnification && floating && renderMode !== "performance";

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    updatePreference("dock", (current) => {
      const from = current.pinned.indexOf(String(active.id));
      const to = current.pinned.indexOf(String(over.id));
      return from < 0 || to < 0
        ? current
        : { ...current, pinned: arrayMove(current.pinned, from, to) };
    });
  };

  // Magnification: scale icons by pointer distance, written straight to CSS variables.
  const onPointerMove = (event: ReactPointerEvent) => {
    if (!magnify || !listRef.current) return;
    for (const button of listRef.current.querySelectorAll<HTMLElement>(".everyos-dock-button")) {
      const box = button.getBoundingClientRect();
      const center = vertical ? box.top + box.height / 2 : box.left + box.width / 2;
      const distance = Math.abs((vertical ? event.clientY : event.clientX) - center);
      button.style.setProperty("--dock-scale", String(1 + 0.4 * Math.max(0, 1 - distance / 130)));
    }
  };
  const resetScale = () => {
    for (const button of listRef.current?.querySelectorAll<HTMLElement>(".everyos-dock-button") ??
      [])
      button.style.removeProperty("--dock-scale");
  };

  const positionClass = {
    bottom: floating ? "bottom-2.5 left-1/2" : "inset-x-0 bottom-0",
    left: floating ? "left-2.5 top-1/2" : "bottom-0 left-0 top-[var(--everyos-menubar-height)]",
    right: floating ? "right-2.5 top-1/2" : "bottom-0 right-0 top-[var(--everyos-menubar-height)]",
  }[dock.position];
  const hidden = dock.autoHide && !revealed;
  const centering = floating ? (vertical ? "translateY(-50%)" : "translateX(-50%)") : "";
  const offscreen = hidden
    ? {
        bottom: "translateY(calc(100% + 16px))",
        left: "translateX(calc(-100% - 16px))",
        right: "translateX(calc(100% + 16px))",
      }[dock.position]
    : "";
  const reveal = () => {
    clearTimeout(hideTimer.current);
    setRevealed(true);
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setRevealed(false), 500);
  };

  const desktopWindows = windows.filter((window) => window.desktopId === activeDesktopId);

  return (
    <Tooltip.Provider>
      {dock.autoHide ? (
        <div
          aria-hidden
          onPointerEnter={reveal}
          className={cn(
            "fixed z-[59]",
            dock.position === "bottom"
              ? "inset-x-0 bottom-0 h-1.5"
              : dock.position === "left"
                ? "inset-y-0 left-0 w-1.5"
                : "inset-y-0 right-0 w-1.5",
          )}
        />
      ) : null}
      <nav
        aria-label={t("dock.label")}
        data-testid="dock"
        data-style={dock.style}
        data-position={dock.position}
        data-hidden={hidden || undefined}
        className={cn("fixed z-[60] flex transition-transform duration-200", positionClass)}
        style={{ transform: [centering, offscreen].filter(Boolean).join(" ") || undefined }}
        onPointerEnter={dock.autoHide ? reveal : undefined}
        onFocus={dock.autoHide ? reveal : undefined}
        onBlur={dock.autoHide ? scheduleHide : undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          resetScale();
          if (dock.autoHide) scheduleHide();
        }}
      >
        <div
          aria-hidden
          className={cn(
            "glass-strong absolute inset-0",
            floating ? "rounded-everyos-lg" : "rounded-none border-x-0 border-b-0",
          )}
          style={{ opacity: dock.opacity }}
        />
        <div
          className={cn(
            "relative flex items-center gap-1.5",
            vertical ? "flex-col px-2 py-2.5" : "px-2.5 py-2",
            !floating && (vertical ? "w-full" : "w-full"),
          )}
        >
          <WithTooltip label={t("dock.launcher")} side={side}>
            <button
              type="button"
              aria-label={t("dock.launcher")}
              onClick={openLauncher}
              className="grid place-items-center rounded-everyos-md text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              style={{ width: dock.iconSize, height: dock.iconSize }}
            >
              <LayoutGrid style={{ width: dock.iconSize * 0.46, height: dock.iconSize * 0.46 }} />
            </button>
          </WithTooltip>
          <span aria-hidden className={cn("bg-line", vertical ? "h-px w-8" : "h-8 w-px")} />
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={pinned}
              strategy={vertical ? verticalListSortingStrategy : horizontalListSortingStrategy}
            >
              <ul
                ref={listRef}
                aria-describedby="dock-reorder-hint"
                className={cn("flex items-center gap-1.5", vertical && "flex-col")}
              >
                {pinned.map((appId) => (
                  <DockItem
                    key={appId}
                    appId={appId}
                    sortable
                    windows={windows}
                    dock={dock}
                    side={side}
                  />
                ))}
                {!taskbar && runningExtra.length > 0 ? (
                  <li aria-hidden className={cn("bg-line", vertical ? "h-px w-8" : "h-8 w-px")} />
                ) : null}
                {!taskbar
                  ? runningExtra.map((appId) => (
                      <DockItem
                        key={appId}
                        appId={appId}
                        sortable={false}
                        windows={windows}
                        dock={dock}
                        side={side}
                      />
                    ))
                  : null}
              </ul>
            </SortableContext>
          </DndContext>
          {taskbar && !vertical ? (
            <>
              <span aria-hidden className="h-8 w-px bg-line" />
              <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {desktopWindows.map((window) => (
                  <TaskbarWindow
                    key={window.id}
                    window={window}
                    focused={focusedId === window.id}
                  />
                ))}
              </ul>
            </>
          ) : null}
          <StorageShelf
            side={side}
            size={dock.iconSize}
            vertical={vertical}
            tooltip={(label, trigger) => (
              <WithTooltip label={label} side={side}>
                {trigger}
              </WithTooltip>
            )}
          />
          <span id="dock-reorder-hint" className="sr-only">
            {t("dock.reorderHint")}
          </span>
        </div>
      </nav>
    </Tooltip.Provider>
  );
}
