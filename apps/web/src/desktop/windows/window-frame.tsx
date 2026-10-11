import { effectiveRect } from "@otuken/window-manager";
import { Copy, Maximize2, Minimize2, Minus, PanelLeft, PanelRight, Square, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { AppHostContext, type AppHost } from "../apps/app-context.ts";
import { AppIcon } from "../apps/app-icon.tsx";
import { getApp } from "../apps/registry.ts";
import type { MenuEntry } from "../menus/menu-model.ts";
import { ContextMenuArea } from "../menus/menus.tsx";
import { usePreferences } from "../state/preferences-store.ts";
import { useWindowManager, wm } from "../state/window-store.ts";
import { AppContent } from "./app-content.tsx";
import { startWindowDrag, startWindowResize, type ResizeEdge } from "./interactions.ts";

const EDGES: Array<{ edge: ResizeEdge; className: string }> = [
  { edge: "n", className: "inset-x-3 -top-1 h-2 cursor-ns-resize" },
  { edge: "s", className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edge: "e", className: "inset-y-3 -right-1 w-2 cursor-ew-resize" },
  { edge: "w", className: "inset-y-3 -left-1 w-2 cursor-ew-resize" },
  { edge: "ne", className: "-right-1 -top-1 size-4 cursor-nesw-resize" },
  { edge: "nw", className: "-left-1 -top-1 size-4 cursor-nwse-resize" },
  { edge: "se", className: "-bottom-1 -right-1 size-4 cursor-nwse-resize" },
  { edge: "sw", className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" },
];

/** One macOS-style window button (close, minimize, zoom); its glyph shows on hover. */
function TrafficLight({
  kind,
  label,
  onClick,
  children,
}: {
  kind: "close" | "minimize" | "zoom";
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-kind={kind}
      onClick={onClick}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="otk-traffic"
    >
      {children}
    </button>
  );
}

/**
 * One desktop window. Geometry changes during drag/resize are painted
 * imperatively; React re-renders only when the committed state changes, and
 * the app content is memoized so moving a window never re-renders the app.
 */
export const WindowFrame = memo(function WindowFrame({
  id,
  zIndex,
}: {
  id: string;
  zIndex: number;
}) {
  const { t } = useTranslation();
  const window = useWindowManager((state) => state.windows[id]);
  const focused = useWindowManager((state) => state.focusedId === id);
  const activeDesktopId = useWindowManager((state) => state.activeDesktopId);
  const viewport = useWindowManager((state) => state.viewport);
  const desktops = usePreferences((state) => state.desktop.desktops);
  const frameRef = useRef<HTMLElement>(null);

  const appState = window?.appState;
  const host = useMemo<AppHost>(
    () => ({
      windowId: id,
      appState,
      setAppState: (next) => wm().setAppState(id, next),
      setTitle: (title) => wm().setTitle(id, title),
      close: () => wm().close(id),
    }),
    [id, appState],
  );

  // Move keyboard focus into a window that becomes active (e.g. opened from the launcher).
  useEffect(() => {
    const frame = frameRef.current;
    if (focused && frame && !frame.contains(document.activeElement))
      frame.focus({ preventScroll: true });
  }, [focused]);

  if (!window) return null;
  const manifest = getApp(window.appId);
  if (!manifest) return null;

  const rect = effectiveRect(window, viewport);
  const hidden = window.minimized || window.desktopId !== activeDesktopId;
  const title = window.title || t(manifest.titleKey);
  const maximized = window.layout === "maximized";
  const fullscreen = window.layout === "fullscreen";
  const floating = window.layout === "floating";

  const menu = (): MenuEntry[] => [
    {
      kind: "item",
      id: "min",
      label: t("window.minimize"),
      icon: <Minus />,
      shortcut: "Ctrl+Alt+↓",
      onSelect: () => wm().minimize(id),
    },
    {
      kind: "item",
      id: "max",
      label: maximized ? t("window.restore") : t("window.maximize"),
      icon: maximized ? <Copy /> : <Square />,
      shortcut: "Ctrl+Alt+↑",
      onSelect: () => wm().toggleMaximize(id),
    },
    {
      kind: "item",
      id: "left",
      label: t("window.snapLeft"),
      icon: <PanelLeft />,
      shortcut: "Ctrl+Alt+←",
      onSelect: () => wm().setLayout(id, "left"),
    },
    {
      kind: "item",
      id: "right",
      label: t("window.snapRight"),
      icon: <PanelRight />,
      shortcut: "Ctrl+Alt+→",
      onSelect: () => wm().setLayout(id, "right"),
    },
    {
      kind: "item",
      id: "full",
      label: fullscreen ? t("window.exitFullscreen") : t("window.fullscreen"),
      icon: fullscreen ? <Minimize2 /> : <Maximize2 />,
      onSelect: () => wm().toggleFullscreen(id),
    },
    {
      kind: "submenu",
      id: "desktop",
      label: t("window.moveToDesktop"),
      disabled: desktops.length < 2,
      entries: desktops
        .filter((desktop) => desktop.id !== window.desktopId)
        .map((desktop) => ({
          kind: "item" as const,
          id: desktop.id,
          label: desktop.name,
          onSelect: () => wm().moveToDesktop(id, desktop.id),
        })),
    },
    { kind: "separator", id: "s" },
    {
      kind: "item",
      id: "close",
      label: t("window.close"),
      icon: <X />,
      shortcut: "Ctrl+Alt+W",
      onSelect: () => wm().close(id),
    },
  ];

  return (
    <section
      ref={frameRef}
      role="region"
      aria-label={title}
      tabIndex={-1}
      hidden={hidden}
      data-window-id={id}
      data-app-id={window.appId}
      data-focused={focused || undefined}
      data-layout={window.layout}
      onPointerDownCapture={() => {
        if (!focused) wm().focus(id);
      }}
      className={cn(
        "otk-window-enter glass-strong pointer-events-auto absolute left-0 top-0 flex flex-col overflow-hidden outline-none",
        fullscreen || maximized ? "rounded-none" : "rounded-otk-lg",
        !focused && "[--otk-surface-strong-opacity:var(--otk-surface-opacity)]",
      )}
      style={{
        transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
        width: rect.width,
        height: rect.height,
        zIndex,
      }}
    >
      <ContextMenuArea entries={menu}>
        <header
          className={cn(
            "relative flex h-10 shrink-0 touch-none select-none items-center border-b border-line px-3",
            focused ? "text-fg" : "text-fg-muted",
          )}
          onPointerDown={(event) =>
            frameRef.current && startWindowDrag(event, id, frameRef.current)
          }
          onDoubleClick={() => wm().toggleMaximize(id)}
        >
          <div
            className="otk-traffic-group relative z-10 flex items-center gap-2"
            data-active={focused}
          >
            <TrafficLight kind="close" label={t("window.close")} onClick={() => wm().close(id)}>
              <X />
            </TrafficLight>
            <TrafficLight
              kind="minimize"
              label={t("window.minimize")}
              onClick={() => wm().minimize(id)}
            >
              <Minus />
            </TrafficLight>
            <TrafficLight
              kind="zoom"
              label={maximized ? t("window.restore") : t("window.maximize")}
              onClick={() => wm().toggleMaximize(id)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </TrafficLight>
          </div>
          {/* Centered like macOS; clicks fall through so the bar still drags. */}
          <div className="pointer-events-none absolute inset-x-24 flex items-center justify-center gap-2">
            <AppIcon manifest={manifest} size={16} />
            <h2 className="min-w-0 truncate text-[0.8rem] font-semibold">{title}</h2>
          </div>
        </header>
      </ContextMenuArea>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AppHostContext.Provider value={host}>
          <AppContent appId={window.appId} />
        </AppHostContext.Provider>
      </div>
      {floating
        ? EDGES.map(({ edge, className }) => (
            <div
              key={edge}
              aria-hidden
              data-resize-edge={edge}
              className={cn("absolute z-10 touch-none", className)}
              onPointerDown={(event) =>
                frameRef.current && startWindowResize(event, id, frameRef.current, edge)
              }
            />
          ))
        : null}
    </section>
  );
});
