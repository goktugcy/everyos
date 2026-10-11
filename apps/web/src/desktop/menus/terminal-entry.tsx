import type { Permission } from "@otuken/shared";
import { SquareTerminal } from "lucide-react";
import { getApp, isAppAllowed } from "../apps/registry.ts";
import { desktop } from "../state/controller.ts";
import type { MenuEntry } from "./menu-model.ts";

/** "Open Terminal" for context menus, only when the user may use the terminal. */
export function openTerminalEntries(
  label: string,
  permissions: readonly Permission[],
): MenuEntry[] {
  const manifest = getApp("otuken.terminal");
  if (!manifest || !isAppAllowed(manifest, permissions)) return [];
  return [
    {
      kind: "item",
      id: "open-terminal",
      label,
      icon: <SquareTerminal />,
      onSelect: () => desktop.openWindow("otuken.terminal"),
    },
  ];
}
