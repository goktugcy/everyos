import type { Messages } from "@everyos/i18n/client";
import { widgetKey } from "@everyos/widget-sdk";
import type { TFunction } from "i18next";
import type { LayoutError } from "@everyos/widget-sdk";

type ItemKey = keyof Messages["widgets"]["items"];

/** i18n key of a built-in widget (every manifest has one; checked by a test). */
export function itemKey(widgetId: string): ItemKey {
  return widgetKey(widgetId) as ItemKey;
}

export function widgetTitle(t: TFunction, widgetId: string): string {
  return t(`widgets.items.${itemKey(widgetId)}.title`);
}

export function widgetDescription(t: TFunction, widgetId: string): string {
  return t(`widgets.items.${itemKey(widgetId)}.description`);
}

export function layoutErrorMessage(t: TFunction, reason: LayoutError["reason"]): string {
  return t(`widgets.layoutErrors.${reason}`);
}
