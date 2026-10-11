import type { WidgetInstance, WidgetPlacement } from "@everyos/shared";
import { getWidget, sizesFor, supportsPlacement } from "@everyos/widget-sdk";
import type { TFunction } from "i18next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  LayoutPanelLeft,
  Maximize2,
  Settings2,
  Trash2,
} from "lucide-react";
import type { MenuEntry } from "../menus/menu-model.ts";
import { wm } from "../state/window-store.ts";
import { widgetActions, type WidgetActionResult } from "./actions.ts";
import { layoutErrorMessage, widgetTitle } from "./labels.ts";
import { widgetUi } from "./ui-store.ts";

const PLACEMENTS: WidgetPlacement[] = ["desktop", "sidebar", "menubar"];

function report(t: TFunction, result: WidgetActionResult): void {
  if (!result.ok) widgetUi.notify(layoutErrorMessage(t, result.reason));
}

/** Actions of one placed widget (frame menu, right-click menu, menu bar item). */
export function widgetMenu(t: TFunction, instance: WidgetInstance): MenuEntry[] {
  const manifest = getWidget(instance.widgetId);
  const remove: MenuEntry = {
    kind: "item",
    id: "remove",
    label: t("widgets.menu.remove"),
    icon: <Trash2 />,
    danger: true,
    onSelect: () => widgetActions.remove(instance.id),
  };
  if (!manifest) return [remove];

  const sizes = sizesFor(manifest, instance.placement).filter(
    (size) => size !== "custom" || instance.size === "custom",
  );
  const horizontal = instance.placement === "menubar";
  const desktop = instance.placement === "desktop";
  return [
    {
      kind: "item",
      id: "configure",
      label: t("widgets.menu.configure"),
      icon: <Settings2 />,
      onSelect: () => widgetUi.configure(instance.id),
    },
    ...(sizes.length > 1
      ? [
          {
            kind: "submenu" as const,
            id: "size",
            label: t("widgets.menu.size"),
            icon: <Maximize2 />,
            disabled: instance.locked,
            entries: sizes.map((size) => ({
              kind: "check" as const,
              id: size,
              label: t(`widgets.sizes.${size}`),
              checked: instance.size === size,
              onCheckedChange: () => {
                if (!widgetActions.resize(instance.id, size, instance.custom))
                  widgetUi.notify(layoutErrorMessage(t, "no-space"));
              },
            })),
          },
        ]
      : []),
    {
      kind: "submenu",
      id: "placement",
      label: t("widgets.menu.moveTo"),
      icon: <LayoutPanelLeft />,
      entries: PLACEMENTS.filter(
        (placement) => placement !== instance.placement && supportsPlacement(manifest, placement),
      ).map((placement) => ({
        kind: "item" as const,
        id: placement,
        label: t(`widgets.placements.${placement}`),
        onSelect: () => report(t, widgetActions.place(instance.id, placement)),
      })),
    },
    ...(desktop
      ? [
          {
            kind: "check" as const,
            id: "pin",
            label: t("widgets.menu.allDesktops"),
            checked: instance.desktopId === null,
            onCheckedChange: (checked: boolean) =>
              widgetActions.update(instance.id, {
                desktopId: checked ? null : wm().activeDesktopId,
              }),
          },
          {
            kind: "check" as const,
            id: "lock",
            label: t("widgets.menu.lock"),
            checked: instance.locked,
            onCheckedChange: (checked: boolean) =>
              widgetActions.update(instance.id, { locked: checked }),
          },
        ]
      : [
          {
            kind: "item" as const,
            id: "earlier",
            label: horizontal ? t("widgets.menu.moveLeft") : t("widgets.menu.moveUp"),
            icon: horizontal ? <ArrowLeft /> : <ArrowUp />,
            onSelect: () => widgetActions.reorder(instance.id, -1),
          },
          {
            kind: "item" as const,
            id: "later",
            label: horizontal ? t("widgets.menu.moveRight") : t("widgets.menu.moveDown"),
            icon: horizontal ? <ArrowRight /> : <ArrowDown />,
            onSelect: () => widgetActions.reorder(instance.id, 1),
          },
        ]),
    { kind: "separator", id: "s1" },
    {
      kind: "item",
      id: "duplicate",
      label: t("widgets.menu.duplicate"),
      icon: <Copy />,
      onSelect: () => report(t, widgetActions.duplicate(instance.id)),
    },
    {
      ...remove,
      label: t("widgets.menu.removeNamed", { name: widgetTitle(t, instance.widgetId) }),
    },
  ];
}
