import type { FileRootView, FileRootsResponse, StandardFolder } from "@everyos/shared";
import { STANDARD_FOLDERS } from "@everyos/shared";
import {
  Clapperboard,
  Computer,
  Download,
  EyeOff,
  FileText,
  FolderCog,
  HardDrive,
  House,
  Image,
  Lock,
  Monitor,
  Music,
  Package,
  ScrollText,
  Server,
  Usb,
  Users,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/cn.ts";
import type { FileLocation } from "./lib.ts";
import { desktop } from "../../state/controller.ts";

export const FILES_FOLDER_ICONS: Record<StandardFolder, LucideIcon> = {
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: Music,
  videos: Clapperboard,
};

const SYSTEM_ICONS: Record<string, LucideIcon> = {
  "sys-root": Computer,
  "sys-home": Users,
  "sys-etc": FolderCog,
  "sys-log": ScrollText,
  "sys-srv": Server,
  "sys-mnt": HardDrive,
  "sys-media": Usb,
  "sys-opt": Package,
};

export interface DropHandlers {
  allowDrop: (event: DragEvent, target: string) => void;
  drop: (event: DragEvent, into: FileLocation) => void;
  dropTarget: string | null;
  clearDrop: () => void;
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <h3 className="text-[0.68rem] font-semibold text-fg-subtle">{title}</h3>
        {aside}
      </div>
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

function Item({
  icon: Icon,
  label,
  hint,
  active,
  disabled,
  readOnly,
  target,
  into,
  onGo,
  drops,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  active: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  target: string;
  into: FileLocation;
  onGo: (location: FileLocation) => void;
  drops: DropHandlers;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        aria-current={active ? "location" : undefined}
        title={hint ?? label}
        onClick={() => onGo(into)}
        onDragOver={readOnly ? undefined : (event) => drops.allowDrop(event, target)}
        onDragLeave={drops.clearDrop}
        onDrop={readOnly ? undefined : (event) => drops.drop(event, into)}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.82rem] outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
          active ? "bg-hover/15 font-medium text-fg" : "text-fg hover:bg-hover/8",
          drops.dropTarget === target && "ring-2 ring-accent",
        )}
      >
        <Icon
          className={cn("size-4 shrink-0", active ? "text-accent" : "text-accent/80")}
          aria-hidden
        />
        <span className="min-w-0 truncate">{label}</span>
        {readOnly ? (
          <Lock
            className="ml-auto size-3 shrink-0 text-fg-subtle"
            aria-label={t("files.readOnly")}
          />
        ) : null}
      </button>
    </li>
  );
}

/**
 * Finder-style sidebar: the user's home and its fixed standard folders,
 * the configured locations, and (for administrators) read-only system paths.
 */
export function FilesSidebar({
  roots,
  system,
  location,
  onGo,
  drops,
  onSystem,
}: {
  roots: FileRootView[];
  system: FileRootsResponse["system"] | null;
  location: FileLocation | null;
  onGo: (location: FileLocation) => void;
  drops: DropHandlers;
  onSystem: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const home = roots.find((root) => root.kind === "home");
  const locations = roots.filter((root) => root.kind === "location");
  const systemRoots = roots.filter((root) => root.kind === "system");
  const at = (root: string, path: string) => location?.root === root && location.path === path;

  return (
    <nav
      aria-label={t("files.locations")}
      className="w-52 shrink-0 overflow-y-auto border-r border-line bg-hover/[0.035] px-2 py-3 max-sm:hidden"
      data-testid="files-sidebar"
    >
      {home ? (
        <Section title={t("files.favorites")}>
          <Item
            icon={House}
            label={home.name}
            hint={t("files.homeHint")}
            active={at(home.id, "")}
            disabled={!home.available}
            target={`root:${home.id}`}
            into={{ root: home.id, path: "" }}
            onGo={onGo}
            drops={drops}
          />
          {STANDARD_FOLDERS.map((kind) => {
            const path = home.folders?.[kind];
            if (!path) return null;
            return (
              <Item
                key={kind}
                icon={FILES_FOLDER_ICONS[kind]}
                label={path}
                active={at(home.id, path)}
                disabled={!home.available}
                target={`fav:${kind}`}
                into={{ root: home.id, path }}
                onGo={onGo}
                drops={drops}
              />
            );
          })}
        </Section>
      ) : null}

      {locations.length > 0 ? (
        <Section title={t("files.locations")}>
          {locations.map((root) => (
            <Item
              key={root.id}
              icon={HardDrive}
              label={root.name}
              active={at(root.id, "")}
              disabled={!root.available}
              readOnly={root.readOnly}
              target={`root:${root.id}`}
              into={{ root: root.id, path: "" }}
              onGo={onGo}
              drops={drops}
            />
          ))}
        </Section>
      ) : null}

      {system?.canManage ? (
        <Section
          title={t("files.systemSection")}
          aside={
            system.enabled ? (
              <button
                type="button"
                aria-label={t("files.hideSystem")}
                title={t("files.hideSystem")}
                onClick={() => onSystem(false)}
                className="grid size-5 place-items-center rounded text-fg-subtle outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              >
                <EyeOff className="size-3.5" aria-hidden />
              </button>
            ) : null
          }
        >
          {system.enabled ? (
            systemRoots.map((root) => (
              <Item
                key={root.id}
                icon={SYSTEM_ICONS[root.id] ?? HardDrive}
                label={t(`files.system.${root.id as "sys-root"}`, { defaultValue: root.name })}
                hint={root.name}
                active={at(root.id, "")}
                readOnly
                target={`root:${root.id}`}
                into={{ root: root.id, path: "" }}
                onGo={onGo}
                drops={drops}
              />
            ))
          ) : (
            <li>
              <button
                type="button"
                onClick={() => onSystem(true)}
                className="w-full rounded-md px-2 py-1 text-left text-[0.75rem] text-fg-muted outline-none hover:bg-hover/8 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("files.showSystem")}
              </button>
            </li>
          )}
        </Section>
      ) : null}
      <button
        type="button"
        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.82rem] text-fg outline-none hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => desktop.openApp("everyos.trash")}
      >
        <Trash2 className="size-4 text-fg-muted" aria-hidden />
        {t("apps.trash")}
      </button>
    </nav>
  );
}
