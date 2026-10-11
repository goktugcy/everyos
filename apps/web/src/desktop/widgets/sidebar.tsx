import type { WidgetInstance } from "@everyos/shared";
import { ordered } from "@everyos/widget-sdk";
import { PanelRightClose, Plus } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { dockThickness, MENUBAR_HEIGHT, WIDGET_SIDEBAR_WIDTH } from "../state/window-store.ts";
import { widgetActions } from "./actions.ts";
import { WidgetFrame } from "./frame.tsx";
import { widgetUi } from "./ui-store.ts";

/** Sidebar tiles: small widgets sit side by side, larger ones span the panel. */
function tileClass(instance: WidgetInstance): string {
  if (instance.size === "small") return "col-span-1 aspect-square";
  if (instance.size === "large") return "col-span-2 h-72";
  return "col-span-2 h-36";
}

/** Right-hand widget panel; the window work area leaves room for it while it is open. */
export function WidgetSidebar() {
  const { t } = useTranslation();
  const open = usePreferences((state) => state.widgets.sidebar.open);
  const widgets = usePreferences((state) => state.widgets);
  const dock = usePreferences((state) => state.dock);
  const items = useMemo(() => ordered(widgets, "sidebar"), [widgets]);
  if (!open) return null;
  const thickness = dockThickness(dock);
  return (
    <aside
      aria-label={t("widgets.sidebar.label")}
      data-testid="widget-sidebar"
      className="glass-strong fixed z-[25] flex flex-col rounded-none border-y-0 border-r-0"
      style={{
        top: MENUBAR_HEIGHT,
        right: dock.position === "right" ? thickness : 0,
        bottom: dock.position === "bottom" ? thickness : 0,
        width: WIDGET_SIDEBAR_WIDTH,
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pl-4 pr-2">
        <h2 className="flex-1 text-sm font-semibold">{t("widgets.title")}</h2>
        <button
          type="button"
          aria-label={t("widgets.menu.addWidget")}
          title={t("widgets.menu.addWidget")}
          className="grid size-7 place-items-center rounded-md text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => widgetUi.openGallery("sidebar")}
        >
          <Plus className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("widgets.sidebar.hide")}
          title={t("widgets.sidebar.hide")}
          className="grid size-7 place-items-center rounded-md text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => widgetActions.setSidebar(false)}
        >
          <PanelRightClose className="size-4" aria-hidden />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-muted">
          <p>{t("widgets.sidebar.empty")}</p>
          <button
            type="button"
            className="button-accent rounded-everyos-sm px-3 py-1.5 text-sm font-medium"
            onClick={() => widgetUi.openGallery("sidebar")}
          >
            {t("widgets.menu.addWidget")}
          </button>
        </div>
      ) : (
        <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-3">
          {items.map((instance) => (
            <WidgetFrame
              key={instance.id}
              instance={instance}
              className={cn(tileClass(instance))}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
