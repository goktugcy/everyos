import type { FileEntry } from "@everyos/shared";
import type { LucideIcon } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { cn } from "../../../lib/cn.ts";
import type { MenuEntry } from "../../menus/menu-model.ts";
import { ContextMenuArea } from "../../menus/menus.tsx";
import { joinPath, kindOf, type FileLocation } from "./lib.ts";
import { FolderIcon } from "./folder-icon.tsx";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { IconLabel } from "../../../components/ui/icon-label.tsx";

interface ItemProps {
  "data-name": string;
  "data-testid": string;
  "aria-selected": boolean;
  draggable: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragOver: ((event: DragEvent) => void) | undefined;
  onDragLeave: (() => void) | undefined;
  onDrop: ((event: DragEvent) => unknown) | undefined;
  onClick: (event: MouseEvent) => void;
  onContextMenu: () => void;
  onDoubleClick: () => void;
}

/**
 * Finder's icon view: large icons (thumbnails for images), names below, the
 * selection highlighted around both glyph and name. Behaviour comes from the same handlers as
 * the list view.
 */
export function FileIconView({
  entries,
  selected,
  renaming,
  dropTarget,
  itemProps,
  isCut,
  renameField,
  menuFor,
  thumbnail,
  badge,
  location,
  pinned,
}: {
  location: FileLocation | null;
  pinned?: ReactNode;
  entries: FileEntry[];
  selected: ReadonlySet<string>;
  renaming: string | null;
  dropTarget: string | null;
  itemProps: (entry: FileEntry) => ItemProps;
  isCut: (entry: FileEntry) => boolean;
  renameField: (entry: FileEntry, className: string) => ReactNode;
  menuFor: (entry: FileEntry) => MenuEntry[];
  thumbnail: (entry: FileEntry) => string | null;
  /** A glyph on standard folders (Documents, Downloads…), like Finder. */
  badge: (entry: FileEntry) => LucideIcon | null;
}) {
  return (
    <ul
      className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] content-start gap-1 p-3"
      data-testid="file-icons"
      data-icon-grid
    >
      {pinned}
      {entries.map((entry) => {
        const isSelected = selected.has(entry.name);
        const folder = kindOf(entry) === "folder";
        const thumb = thumbnail(entry);
        const Badge = badge(entry);
        return (
          <ContextMenuArea key={entry.name} entries={() => menuFor(entry)}>
            <li
              {...itemProps(entry)}
              aria-label={entry.name}
              className={cn(
                "flex cursor-default select-none flex-col items-center gap-1 rounded-lg p-1.5",
                isCut(entry) && "opacity-50",
                "relative hover:z-20",
                isSelected && "z-10 bg-hover/15 ring-1 ring-accent/30",
                dropTarget === `row:${entry.name}` && "ring-2 ring-accent",
              )}
            >
              <div className="relative grid size-[68px] place-items-center rounded-lg">
                {folder ? (
                  <FolderIcon
                    location={
                      location
                        ? { root: location.root, path: joinPath(location.path, entry.name) }
                        : null
                    }
                    badge={Badge}
                  />
                ) : thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className="max-h-14 max-w-14 rounded-[3px] object-contain shadow-md ring-1 ring-black/10"
                  />
                ) : (
                  <FileTypeIcon entry={entry} />
                )}
              </div>
              {renaming === entry.name ? (
                renameField(entry, "w-full text-center text-xs")
              ) : (
                <IconLabel text={entry.name} />
              )}
            </li>
          </ContextMenuArea>
        );
      })}
    </ul>
  );
}
