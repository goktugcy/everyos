import type { Permission } from "@everyos/shared";
import type { ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

/**
 * Declarative menu entries shared by context menus, dropdowns (menu bar) and
 * the dock. Permission-gated entries are removed for users who lack the
 * permission; the API enforces the same permission independently.
 */
export type MenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      permission?: Permission;
      confirm?: ConfirmOptions;
      onSelect: () => void;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      permission?: Permission;
      entries: MenuEntry[];
    }
  | {
      kind: "check";
      id: string;
      label: string;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }
  | { kind: "label"; id: string; label: string }
  | { kind: "separator"; id: string };

/** Drops forbidden entries, empty submenus and redundant separators. */
export function filterMenu(entries: MenuEntry[], permissions: readonly Permission[]): MenuEntry[] {
  const allowed = entries.flatMap((entry): MenuEntry[] => {
    if (
      (entry.kind === "item" || entry.kind === "submenu") &&
      entry.permission &&
      !permissions.includes(entry.permission)
    ) {
      return [];
    }
    if (entry.kind === "submenu") {
      const children = filterMenu(entry.entries, permissions);
      return children.length > 0 ? [{ ...entry, entries: children }] : [];
    }
    return [entry];
  });
  const compact: MenuEntry[] = [];
  for (const entry of allowed) {
    const previous = compact.at(-1);
    if (entry.kind === "separator" && (!previous || previous.kind === "separator")) continue;
    compact.push(entry);
  }
  while (compact.at(-1)?.kind === "separator") compact.pop();
  return compact;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Formats a shortcut such as "Ctrl+Alt+W" for display on the current platform. */
export function formatShortcut(shortcut: string): string {
  if (!isMac) return shortcut;
  return shortcut
    .replace(/Ctrl\+/g, "⌃")
    .replace(/Alt\+/g, "⌥")
    .replace(/Shift\+/g, "⇧")
    .replace(/Mod\+/g, "⌘");
}
