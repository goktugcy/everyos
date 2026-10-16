import type { AiConversationSummary } from "@everyos/shared";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  MessageCircle,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/cn.ts";
import type { MenuEntry } from "../../menus/menu-model.ts";
import { ContextMenuArea } from "../../menus/menus.tsx";

/**
 * A chat history in three parts: favorites first, then recent chats, then the archive (closed by
 * default). Every entry has a right-click menu (also Menu key / Shift+F10) to favorite, archive
 * or delete it.
 */
export function ConversationList({
  conversations,
  activeId,
  disabled,
  narrow = false,
  onOpen,
  onUpdate,
  onDelete,
}: {
  conversations: readonly AiConversationSummary[];
  activeId: string | null;
  disabled: boolean;
  /** Icon-only entries on small screens (the chat window's side list). */
  narrow?: boolean;
  onOpen: (id: string) => void;
  onUpdate: (id: string, patch: { favorite?: boolean; archived?: boolean }) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [favoritesOpen, setFavoritesOpen] = useState(true),
    [archiveOpen, setArchiveOpen] = useState(false);
  const favorites = conversations.filter((entry) => entry.favorite && !entry.archived),
    recent = conversations.filter((entry) => !entry.favorite && !entry.archived),
    archived = conversations.filter((entry) => entry.archived);
  const menu = (entry: AiConversationSummary): MenuEntry[] => [
    ...(entry.archived
      ? []
      : [
          {
            kind: "item" as const,
            id: "favorite",
            label: t(
              entry.favorite ? "aiAgents.chatMenu.unfavorite" : "aiAgents.chatMenu.favorite",
            ),
            icon: entry.favorite ? <StarOff /> : <Star />,
            disabled,
            onSelect: () => onUpdate(entry.id, { favorite: !entry.favorite }),
          },
        ]),
    {
      kind: "item",
      id: "archive",
      label: t(entry.archived ? "aiAgents.chatMenu.unarchive" : "aiAgents.chatMenu.archive"),
      icon: entry.archived ? <ArchiveRestore /> : <Archive />,
      disabled,
      onSelect: () => onUpdate(entry.id, { archived: !entry.archived }),
    },
    { kind: "separator", id: "separator" },
    {
      kind: "item",
      id: "delete",
      label: t("aiAgents.chatMenu.delete"),
      icon: <Trash2 />,
      danger: true,
      disabled,
      onSelect: () => onDelete(entry.id),
    },
  ];
  const item = (entry: AiConversationSummary) => {
    const title = entry.title || t("aiAgents.untitled");
    const Icon = entry.archived ? Archive : entry.favorite ? Star : MessageCircle;
    return (
      <ContextMenuArea key={entry.id} entries={() => menu(entry)}>
        <button
          type="button"
          title={title}
          aria-label={title}
          disabled={disabled}
          aria-current={activeId === entry.id ? "true" : undefined}
          data-testid="ai-chat-entry"
          onClick={() => onOpen(entry.id)}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-everyos-md p-2 text-left text-xs outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent",
            activeId === entry.id && "bg-accent/15",
            entry.archived && "text-fg-muted",
          )}
        >
          <Icon
            className={cn("size-4 shrink-0", entry.favorite && "fill-current text-warning")}
            aria-hidden
          />
          <span className={cn("truncate", narrow && "max-sm:sr-only")}>{title}</span>
        </button>
      </ContextMenuArea>
    );
  };
  return (
    <>
      {favorites.length ? (
        <Section
          title={t("aiAgents.lists.favorites")}
          icon={<Star className="size-3.5" aria-hidden />}
          open={favoritesOpen}
          onToggle={() => setFavoritesOpen((value) => !value)}
          narrow={narrow}
          testId="ai-chat-favorites"
        >
          {favorites.map(item)}
        </Section>
      ) : null}
      {recent.length && (favorites.length || archived.length) ? (
        <p
          className={cn(
            "px-2 pb-1 pt-2 text-[0.7rem] font-semibold uppercase tracking-wide text-fg-subtle",
            narrow && "max-sm:sr-only",
          )}
        >
          {t("aiAgents.lists.recent")}
        </p>
      ) : null}
      {recent.map(item)}
      {archived.length ? (
        <Section
          title={t("aiAgents.lists.archive")}
          icon={<Archive className="size-3.5" aria-hidden />}
          open={archiveOpen}
          onToggle={() => setArchiveOpen((value) => !value)}
          narrow={narrow}
          testId="ai-chat-archive"
        >
          {archived.map(item)}
        </Section>
      ) : null}
    </>
  );
}

function Section({
  title,
  icon,
  open,
  onToggle,
  narrow,
  testId,
  children,
}: {
  title: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  narrow: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-1" data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        title={title}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-everyos-sm px-2 pb-1 pt-2 text-[0.7rem] font-semibold uppercase tracking-wide text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
      >
        {icon}
        <span className={cn("flex-1 text-left", narrow && "max-sm:sr-only")}>{title}</span>
        <ChevronDown
          className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
          aria-hidden
        />
      </button>
      {open ? children : null}
    </div>
  );
}
