import type { WidgetInstance } from "@everyos/shared";
import { getWidget, ordered } from "@everyos/widget-sdk";
import { PanelRight } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { ContextMenuArea } from "../menus/menus.tsx";
import { usePreferences } from "../state/preferences-store.ts";
import { widgetActions } from "./actions.ts";
import { WidgetBody } from "./frame.tsx";
import { widgetTitle } from "./labels.ts";
import { widgetMenu } from "./menu.tsx";
import { menubarButton } from "../menubar/menubar-button.ts";

function MenubarWidget({ instance }: { instance: WidgetInstance }) {
  const { t } = useTranslation();
  const title = getWidget(instance.widgetId)
    ? widgetTitle(t, instance.widgetId)
    : instance.widgetId;
  return (
    <ContextMenuArea entries={() => widgetMenu(t, instance)}>
      <div
        role="group"
        aria-label={title}
        title={title}
        data-testid="menubar-widget"
        data-widget={instance.widgetId}
        className="flex h-7 max-w-44 items-center overflow-hidden rounded-md px-1.5 text-[0.75rem] text-fg"
      >
        <WidgetBody instance={instance} compact />
      </div>
    </ContextMenuArea>
  );
}

/** Compact widgets in the menu bar plus the sidebar toggle. */
export function MenubarWidgets() {
  const { t } = useTranslation();
  const widgets = usePreferences((state) => state.widgets);
  const items = useMemo(() => ordered(widgets, "menubar"), [widgets]);
  const open = widgets.sidebar.open;
  return (
    <div className="flex items-center gap-0.5" data-testid="menubar-widgets">
      {items.map((instance) => (
        <MenubarWidget key={instance.id} instance={instance} />
      ))}
      <button
        type="button"
        className={cn(menubarButton, open && "bg-[rgb(var(--everyos-accent)/0.2)]")}
        aria-pressed={open}
        aria-label={t("widgets.sidebar.label")}
        title={open ? t("widgets.sidebar.hide") : t("widgets.sidebar.show")}
        data-testid="widget-sidebar-toggle"
        onClick={() => widgetActions.setSidebar(!open)}
      >
        <PanelRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}
