import { MENUBAR_MODULE_IDS, type MenubarModuleId, type MenubarPreferences } from "@everyos/shared";

/** Keep the original layout for preferences saved before custom ordering existed. */
const DEFAULT_ORDER: readonly MenubarModuleId[] = [
  "widgets",
  "notifications",
  "resources",
  "power",
  "network",
  "agent",
  "desktops",
  "search",
  "quickSettings",
  "clock",
];

export function moduleOrder(order?: readonly MenubarModuleId[]): MenubarModuleId[] {
  return [...new Set([...(order ?? []), ...DEFAULT_ORDER])].filter((id) =>
    MENUBAR_MODULE_IDS.includes(id),
  );
}

export function moduleVisibility(
  doc: MenubarPreferences,
  id: MenubarModuleId,
  visible: boolean,
): MenubarPreferences {
  return {
    ...doc,
    hidden: visible
      ? doc.hidden.filter((entry) => entry !== id)
      : [...new Set([...doc.hidden, id])],
  };
}

export function moveModule(
  doc: MenubarPreferences,
  id: MenubarModuleId,
  step: -1 | 1,
): MenubarPreferences {
  const order = moduleOrder(doc.order);
  const index = order.indexOf(id);
  const next = index + step;
  if (index < 0 || next < 0 || next >= order.length) return doc;
  [order[index], order[next]] = [order[next]!, order[index]!];
  return { ...doc, order };
}
