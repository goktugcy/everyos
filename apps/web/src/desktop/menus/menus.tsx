import { Check, ChevronRight } from "lucide-react";
import { ContextMenu as CM, DropdownMenu as DM } from "radix-ui";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { requestConfirm } from "./confirm.tsx";
import { filterMenu, formatShortcut, type MenuEntry } from "./menu-model.ts";

const contentClass =
  "glass-strong everyos-enter z-[8000] min-w-56 rounded-everyos-md p-1.5 text-sm text-fg";
const itemClass =
  "relative flex h-8 cursor-default select-none items-center gap-2.5 rounded-[calc(var(--everyos-radius-md)-6px)] px-2.5 outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[rgb(var(--everyos-accent)/0.2)]";

type Primitives = typeof CM | typeof DM;

function select(entry: Extract<MenuEntry, { kind: "item" }>): void {
  if (!entry.confirm) {
    entry.onSelect();
    return;
  }
  void requestConfirm(entry.confirm).then((ok) => ok && entry.onSelect());
}

function Entries({ P, entries }: { P: Primitives; entries: MenuEntry[] }) {
  return (
    <>
      {entries.map((entry) => {
        switch (entry.kind) {
          case "separator":
            return <P.Separator key={entry.id} className="mx-1 my-1.5 h-px bg-line" />;
          case "label":
            return (
              <P.Label
                key={entry.id}
                className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-subtle"
              >
                {entry.label}
              </P.Label>
            );
          case "check":
            return (
              <P.CheckboxItem
                key={entry.id}
                className={cn(itemClass, "pl-8")}
                checked={entry.checked}
                onCheckedChange={(checked) => entry.onCheckedChange(checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="absolute left-2.5 grid size-4 place-items-center">
                  <P.ItemIndicator>
                    <Check className="size-4 text-accent" aria-hidden />
                  </P.ItemIndicator>
                </span>
                {entry.label}
              </P.CheckboxItem>
            );
          case "submenu":
            return (
              <P.Sub key={entry.id}>
                <P.SubTrigger className={itemClass} disabled={entry.disabled === true}>
                  <Icon icon={entry.icon} />
                  <span className="flex-1 truncate">{entry.label}</span>
                  <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
                </P.SubTrigger>
                <P.Portal>
                  <P.SubContent className={contentClass} sideOffset={4} collisionPadding={8}>
                    <Entries P={P} entries={entry.entries} />
                  </P.SubContent>
                </P.Portal>
              </P.Sub>
            );
          case "item":
            return (
              <P.Item
                key={entry.id}
                className={cn(itemClass, entry.danger && "text-danger")}
                disabled={entry.disabled === true}
                onSelect={() => select(entry)}
              >
                <Icon icon={entry.icon} />
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.shortcut ? (
                  <kbd className="font-sans text-xs text-fg-subtle">
                    {formatShortcut(entry.shortcut)}
                  </kbd>
                ) : null}
              </P.Item>
            );
        }
      })}
    </>
  );
}

function Icon({ icon }: { icon: ReactNode }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center text-fg-subtle [&>svg]:size-4">
      {icon}
    </span>
  );
}

function usePermittedEntries(entries: MenuEntry[]): MenuEntry[] {
  const permissions = usePermissions();
  return filterMenu(entries, permissions);
}

/**
 * Right-click (and long-press / Menu key / Shift+F10) menu around `children`.
 * `entries` is evaluated when the menu opens so it always reflects current state.
 */
export function ContextMenuArea({
  entries,
  children,
  disabled,
}: {
  entries: () => MenuEntry[];
  children: ReactNode;
  disabled?: boolean;
}) {
  // Entries are built only while the menu is open.
  const [open, setOpen] = useState(false);
  return (
    <CM.Root modal={false} onOpenChange={setOpen}>
      {/* Stop propagation so a nested area (an icon on the desktop) opens only its own menu. */}
      <CM.Trigger
        asChild
        disabled={disabled === true}
        onContextMenu={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") event.stopPropagation();
        }}
      >
        {children}
      </CM.Trigger>
      <CM.Portal>{open ? <ContextMenuBody entries={entries} /> : null}</CM.Portal>
    </CM.Root>
  );
}

function ContextMenuBody({ entries }: { entries: () => MenuEntry[] }) {
  const items = usePermittedEntries(entries());
  if (items.length === 0) return null;
  return (
    <CM.Content className={contentClass} collisionPadding={8}>
      <Entries P={CM} entries={items} />
    </CM.Content>
  );
}

/** A dropdown menu (menu bar, buttons) using the same entry model. */
export function MenuDropdown({
  trigger,
  entries,
  align = "start",
  label,
}: {
  trigger: ReactNode;
  entries: MenuEntry[];
  align?: "start" | "center" | "end";
  label?: string;
}) {
  const items = usePermittedEntries(entries);
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild aria-label={label}>
        {trigger}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className={contentClass} align={align} sideOffset={6} collisionPadding={8}>
          <Entries P={DM} entries={items} />
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
