import { EmptyState, IconButton, Tabs, useI18n, useT } from "@everyos/app-ui";
import {
  Bookmark as BookmarkIcon,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Bookmark } from "./library.ts";
import type { OutlineItem, PdfSession } from "./types.ts";

export type SidebarTab = "pages" | "outline" | "bookmarks";

const THUMB_WIDTH = 120;

/** One page's thumbnail, drawn the first time it scrolls into view (and again after rotating). */
function Thumbnail({
  session,
  page,
  rotation,
  current,
  onSelect,
}: {
  session: PdfSession;
  page: number;
  rotation: number;
  current: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const item = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = item.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvas.current) return;
    void session.renderThumbnail(page, canvas.current, THUMB_WIDTH).catch(() => undefined);
  }, [session, page, rotation, visible]);

  useEffect(() => {
    if (current) item.current?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  return (
    <button
      ref={item}
      type="button"
      className="pdf-thumb"
      aria-current={current ? "page" : undefined}
      aria-label={t("pages.thumbnail", { page })}
      onClick={onSelect}
    >
      <canvas
        ref={canvas}
        className="pdf-thumb-canvas"
        width={THUMB_WIDTH}
        height={Math.round(THUMB_WIDTH * 1.3)}
      />
      <span>{page}</span>
    </button>
  );
}

function OutlineTree({
  items,
  depth,
  onOpen,
}: {
  items: OutlineItem[];
  depth: number;
  onOpen: (item: OutlineItem) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  return (
    <ul
      className="pdf-outline"
      role={depth === 0 ? "tree" : "group"}
      aria-label={depth === 0 ? t("outline.label") : undefined}
    >
      {items.map((item, index) => {
        const expanded = open.has(index);
        return (
          <li key={index} role="treeitem" aria-expanded={item.items.length ? expanded : undefined}>
            <div className="pdf-outline-row" style={{ paddingInlineStart: `${4 + depth * 12}px` }}>
              {item.items.length ? (
                <IconButton
                  size="sm"
                  label={
                    expanded
                      ? t("outline.collapse", { title: item.title })
                      : t("outline.expand", { title: item.title })
                  }
                  icon={
                    expanded ? (
                      <ChevronDown size={13} aria-hidden />
                    ) : (
                      <ChevronRight size={13} aria-hidden />
                    )
                  }
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                />
              ) : (
                <span className="pdf-outline-indent" />
              )}
              <button
                type="button"
                className="pdf-outline-title"
                data-bold={item.bold || undefined}
                data-italic={item.italic || undefined}
                onClick={() => onOpen(item)}
              >
                {item.title}
                {item.url ? <ExternalLink size={12} aria-label={t("outline.external")} /> : null}
              </button>
            </div>
            {item.items.length && expanded ? (
              <OutlineTree items={item.items} depth={depth + 1} onOpen={onOpen} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar({
  session,
  tab,
  onTab,
  page,
  rotation,
  bookmarks,
  onGoTo,
  onOutline,
  onRenameBookmark,
  onRemoveBookmark,
}: {
  session: PdfSession;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  page: number;
  rotation: number;
  bookmarks: Bookmark[];
  onGoTo: (page: number) => void;
  onOutline: (item: OutlineItem) => void;
  onRenameBookmark: (bookmark: Bookmark) => void;
  onRemoveBookmark: (bookmark: Bookmark) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  return (
    <aside className="pdf-sidebar" aria-label={t("sidebar.label")}>
      <Tabs<SidebarTab>
        label={t("sidebar.label")}
        value={tab}
        onChange={onTab}
        tabs={(["pages", "outline", "bookmarks"] as const).map((value) => ({
          value,
          label: t(`sidebar.${value}`),
        }))}
      />
      <div className="pdf-sidebar-body">
        {tab === "pages" ? (
          <div className="pdf-thumbs" role="list" aria-label={t("sidebar.pages")}>
            {Array.from({ length: session.pageCount }, (_, index) => (
              <div role="listitem" key={index}>
                <Thumbnail
                  session={session}
                  page={index + 1}
                  rotation={rotation}
                  current={page === index + 1}
                  onSelect={() => onGoTo(index + 1)}
                />
              </div>
            ))}
          </div>
        ) : tab === "outline" ? (
          session.outline.length ? (
            <OutlineTree items={session.outline} depth={0} onOpen={onOutline} />
          ) : (
            <EmptyState title={t("outline.empty")} text={t("outline.emptyText")} />
          )
        ) : bookmarks.length ? (
          <ul className="pdf-bookmarks" aria-label={t("sidebar.bookmarks")}>
            {bookmarks.map((bookmark) => (
              <li key={bookmark.page} data-current={bookmark.page === page || undefined}>
                <button
                  type="button"
                  className="pdf-bookmark"
                  onClick={() => onGoTo(bookmark.page)}
                >
                  <BookmarkIcon size={13} aria-hidden />
                  <span className="pdf-bookmark-label">{bookmark.label}</span>
                  <span className="pdf-bookmark-page">{i18n.number(bookmark.page)}</span>
                </button>
                <IconButton
                  size="sm"
                  label={t("bookmarks.rename", { label: bookmark.label })}
                  icon={<Pencil size={13} aria-hidden />}
                  onClick={() => onRenameBookmark(bookmark)}
                />
                <IconButton
                  size="sm"
                  label={t("bookmarks.remove", { label: bookmark.label })}
                  icon={<Trash2 size={13} aria-hidden />}
                  onClick={() => onRemoveBookmark(bookmark)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t("bookmarks.empty")} text={t("bookmarks.emptyText")} />
        )}
      </div>
    </aside>
  );
}
