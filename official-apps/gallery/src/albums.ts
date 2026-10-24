import type { EveryOSApp, FileHandle } from "@everyos/app-sdk";
import { isImage, MAX_IMAGE_BYTES } from "../../images/src/images.ts";

export interface Album {
  id: string;
  name: string;
}
export interface GalleryPreferences {
  albums: Album[];
  current: string | null;
  sort: "name" | "date" | "size";
  interval: number;
}
export interface Root {
  id: string;
  name: string;
}
export interface Photo {
  key: string;
  root: string | null;
  file: string | null;
  path: string;
  name: string;
  size: number;
  modified: number;
  favorite: boolean;
}
export interface AlbumContent {
  roots: Root[];
  items: Photo[];
  indexedAt: number | null;
  partial: boolean;
}
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,128}$/.test(value);
export const albumName = (value: string) =>
  value
    .trim()
    .slice(0, 80)
    .replace(/[\r\n\0]/g, " ")
    .trim();
export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(12))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export const emptyAlbum = (): AlbumContent => ({
  roots: [],
  items: [],
  indexedAt: null,
  partial: false,
});
export const relativePath = (value: string) =>
  value.length <= 1024 &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
export function galleryPreferences(value: unknown): GalleryPreferences {
  const data = value as Partial<GalleryPreferences> | null;
  const albums = Array.isArray(data?.albums)
    ? data.albums
        .filter(
          (item): item is Album =>
            !!item && id(item.id) && typeof item.name === "string" && !!albumName(item.name),
        )
        .slice(0, 20)
        .map((item) => ({ id: item.id, name: albumName(item.name) }))
    : [];
  return {
    albums: [...new Map(albums.map((item) => [item.id, item])).values()],
    current: albums.some((item) => item.id === data?.current)
      ? data!.current!
      : (albums[0]?.id ?? null),
    sort: data?.sort === "date" || data?.sort === "size" ? data.sort : "name",
    interval: [2000, 5000, 10000, 30000].includes(data?.interval ?? 0) ? data!.interval! : 5000,
  };
}
/** One album fits comfortably inside the SDK's 256 KiB per-value ceiling. */
export function albumContent(value: unknown): AlbumContent {
  const data = value as Partial<AlbumContent> | null;
  const roots = Array.isArray(data?.roots)
    ? data.roots
        .filter((root) => root && id(root.id) && typeof root.name === "string")
        .slice(0, 20)
        .map((root) => ({ id: root.id, name: root.name.slice(0, 255) }))
    : [];
  let bytes = new TextEncoder().encode(JSON.stringify(roots)).length + 200;
  let partial = data?.partial === true;
  const items: Photo[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(data?.items) ? data.items.slice(0, 2000) : []) {
    if (
      !candidate ||
      typeof candidate.name !== "string" ||
      candidate.name.length > 255 ||
      !isImage({ name: candidate.name, kind: "file" }) ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0 ||
      candidate.size > MAX_IMAGE_BYTES ||
      !Number.isFinite(candidate.modified) ||
      candidate.modified < 0 ||
      typeof candidate.path !== "string"
    ) {
      partial = true;
      continue;
    }
    const rooted =
      id(candidate.root) &&
      roots.some((root) => root.id === candidate.root) &&
      relativePath(candidate.path);
    if (!rooted && !(candidate.root === null && id(candidate.file) && candidate.path === "")) {
      partial = true;
      continue;
    }
    const key = rooted ? `${candidate.root}:${candidate.path}` : candidate.file!;
    if (seen.has(key)) continue;
    const item: Photo = {
      key,
      root: rooted ? candidate.root : null,
      file: rooted ? null : candidate.file,
      path: candidate.path,
      name: candidate.name,
      size: candidate.size,
      modified: candidate.modified,
      favorite: candidate.favorite === true,
    };
    const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (items.length >= 1000 || bytes + size > 210 * 1024) {
      partial = true;
      break;
    }
    bytes += size;
    items.push(item);
    seen.add(key);
  }
  return {
    roots,
    items,
    indexedAt:
      typeof data?.indexedAt === "number" && Number.isFinite(data.indexedAt) && data.indexedAt >= 0
        ? data.indexedAt
        : null,
    partial,
  };
}
export function photos(
  content: AlbumContent,
  query: string,
  favorites: boolean,
  sort: GalleryPreferences["sort"],
): Photo[] {
  const search = query.trim().toLocaleLowerCase();
  return content.items
    .filter(
      (item) =>
        (!favorites || item.favorite) &&
        `${item.name} ${item.path}`.toLocaleLowerCase().includes(search),
    )
    .toSorted(
      (a, b) =>
        (sort === "date"
          ? b.modified - a.modified
          : sort === "size"
            ? b.size - a.size
            : a.name.localeCompare(b.name)) || a.key.localeCompare(b.key),
    );
}
export function manualPhoto(file: FileHandle): Photo | null {
  return isImage(file) && file.size !== null && file.size <= MAX_IMAGE_BYTES
    ? {
        key: file.id,
        root: null,
        file: file.id,
        path: "",
        name: file.name,
        size: file.size,
        modified: 0,
        favorite: false,
      }
    : null;
}
export async function scanImages(
  files: Pick<EveryOSApp["files"], "list">,
  root: FileHandle,
  options: { cancelled?: () => boolean; now?: () => number } = {},
): Promise<{ items: Photo[]; partial: boolean; visited: number }> {
  if (root.kind !== "directory") throw new Error("Not a directory");
  const now = options.now ?? Date.now;
  const deadline = now() + 30000;
  const stack = [{ path: "", depth: 0 }];
  const items: Photo[] = [];
  let visited = 0;
  let folders = 0;
  let partial = false;
  while (stack.length) {
    if (
      options.cancelled?.() ||
      now() >= deadline ||
      folders >= 200 ||
      visited >= 20000 ||
      items.length >= 1000
    ) {
      partial = true;
      break;
    }
    const folder = stack.pop()!;
    folders++;
    try {
      const entries = await files.list(root, folder.path);
      for (const entry of entries) {
        if (
          options.cancelled?.() ||
          now() >= deadline ||
          visited >= 20000 ||
          items.length >= 1000
        ) {
          partial = true;
          break;
        }
        visited++;
        const path = folder.path ? `${folder.path}/${entry.name}` : entry.name;
        if (!relativePath(path)) {
          partial = true;
          continue;
        }
        if (entry.kind === "directory") {
          if (folder.depth >= 8) partial = true;
          else stack.push({ path, depth: folder.depth + 1 });
        } else if (isImage({ name: entry.name, kind: entry.kind })) {
          if (entry.size === null || entry.size > MAX_IMAGE_BYTES) {
            partial = true;
            continue;
          }
          items.push({
            key: `${root.id}:${path}`,
            root: root.id,
            file: null,
            path,
            name: entry.name,
            size: entry.size,
            modified: entry.modifiedAt ?? 0,
            favorite: false,
          });
        }
      }
    } catch {
      partial = true;
    }
  }
  return { items, partial, visited };
}
export async function photoHandle(
  files: EveryOSApp["files"],
  photo: Photo,
  shares: readonly FileHandle[],
): Promise<FileHandle | null> {
  if (photo.root) {
    const root = shares.find((item) => item.id === photo.root && item.kind === "directory");
    return root ? await files.child(root, photo.path) : null;
  }
  return shares.find((item) => item.id === photo.file && item.kind === "file") ?? null;
}
