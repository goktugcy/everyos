import type { ZoomValue } from "./types.ts";

/** Zoom choices in the menu (factors) next to the presets. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const ZOOM_PRESETS = ["auto", "page-width", "page-fit", "page-actual"] as const;
export type ZoomPreset = (typeof ZOOM_PRESETS)[number];

/** A page number typed by the person, or null when it is not one of the document's pages. */
export function parsePage(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const page = Number(trimmed);
  return page >= 1 && page <= pageCount ? page : null;
}

export const nextRotation = (rotation: number, direction: 1 | -1) =>
  (((rotation + direction * 90) % 360) + 360) % 360;

export interface Bookmark {
  page: number;
  /** The person's name for it (the page's place in the outline when made). */
  label: string;
  createdAt: number;
}

/** What the app remembers about one document (by fingerprint): where it was left, bookmarks. */
export interface DocState {
  page: number;
  zoom: ZoomValue;
  rotation: number;
  bookmarks: Bookmark[];
}

export const MAX_BOOKMARKS = 200;

export function sanitizeDocState(value: unknown): DocState {
  const stored = (typeof value === "object" && value !== null ? value : {}) as Partial<DocState>;
  const zoom = stored.zoom;
  return {
    page: Number.isInteger(stored.page) && stored.page! > 0 ? stored.page! : 1,
    zoom:
      typeof zoom === "number" && zoom >= 0.1 && zoom <= 10
        ? zoom
        : (ZOOM_PRESETS as readonly unknown[]).includes(zoom)
          ? (zoom as ZoomPreset)
          : "auto",
    rotation: [0, 90, 180, 270].includes(stored.rotation ?? -1) ? stored.rotation! : 0,
    bookmarks: Array.isArray(stored.bookmarks)
      ? stored.bookmarks
          .filter(
            (bookmark): bookmark is Bookmark =>
              typeof bookmark === "object" &&
              bookmark !== null &&
              Number.isInteger(bookmark.page) &&
              bookmark.page > 0 &&
              typeof bookmark.label === "string",
          )
          .slice(0, MAX_BOOKMARKS)
      : [],
  };
}

/** Adds a bookmark for a page, or renames the one it has; kept in page order. */
export function setBookmark(list: readonly Bookmark[], bookmark: Bookmark): Bookmark[] {
  const label = bookmark.label.trim().slice(0, 120);
  const others = list.filter((entry) => entry.page !== bookmark.page);
  return [...others, { ...bookmark, label }]
    .sort((a, b) => a.page - b.page)
    .slice(0, MAX_BOOKMARKS);
}

export const removeBookmark = (list: readonly Bookmark[], page: number) =>
  list.filter((entry) => entry.page !== page);

/** A document opened before: its file handle (persistent) and when. */
export interface Recent {
  handleId: string;
  name: string;
  fingerprint: string;
  openedAt: number;
}

export const MAX_RECENT = 12;

export function addRecent(list: readonly Recent[], entry: Recent): Recent[] {
  return [
    entry,
    ...list.filter(
      (item) => item.handleId !== entry.handleId && item.fingerprint !== entry.fingerprint,
    ),
  ].slice(0, MAX_RECENT);
}

export const isRecent = (value: unknown): value is Recent => {
  const entry = value as Recent | null;
  return (
    !!entry &&
    typeof entry.handleId === "string" &&
    typeof entry.name === "string" &&
    typeof entry.fingerprint === "string" &&
    typeof entry.openedAt === "number"
  );
};

/** A storage key for a document's state (fingerprints are hex). */
export const docKey = (fingerprint: string) =>
  `doc/${fingerprint.replace(/[^\w-]/g, "").slice(0, 64)}`;
