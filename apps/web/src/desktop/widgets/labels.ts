import type { Messages } from "@everyos/i18n/client";
import { parseDesktopAppWidgetId, widgetKey } from "@everyos/widget-sdk";
import type { TFunction } from "i18next";
import type { LayoutError } from "@everyos/widget-sdk";
import { useDesktopApps } from "../desktop-apps/store.ts";

type ItemKey = keyof Messages["widgets"]["items"];

/** i18n key of a built-in widget (every manifest has one; checked by a test). */
export function itemKey(widgetId: string): ItemKey {
  return widgetKey(widgetId) as ItemKey;
}

/** A desktop app's widget: its own name and description (the publisher's text). */
function appWidgetText(widgetId: string): { name: string; description: string } | null {
  if (!parseDesktopAppWidgetId(widgetId)) return null;
  return useDesktopApps.getState().widgetNames[widgetId] ?? { name: widgetId, description: "" };
}

export function widgetTitle(t: TFunction, widgetId: string): string {
  return appWidgetText(widgetId)?.name ?? t(`widgets.items.${itemKey(widgetId)}.title`);
}

export function widgetDescription(t: TFunction, widgetId: string): string {
  const app = appWidgetText(widgetId);
  if (!app) return t(`widgets.items.${itemKey(widgetId)}.description`);
  const owner = useDesktopApps.getState().names[parseDesktopAppWidgetId(widgetId)!.appId];
  return [owner, app.description].filter(Boolean).join(" · ");
}

export function layoutErrorMessage(t: TFunction, reason: LayoutError["reason"]): string {
  return t(`widgets.layoutErrors.${reason}`);
}
