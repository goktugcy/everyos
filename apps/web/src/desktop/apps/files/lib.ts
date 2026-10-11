import type {
  FileEntry,
  FileListing,
  FileProperties,
  FileRootsResponse,
  FileSearchResult,
  TextFile,
} from "@otuken/shared";
import { create } from "zustand";
import { api, ApiRequestError, uploadWithProgress } from "../../../lib/api.ts";

/** Drag payload between Files windows and the pulse shelf: `{ root, paths }`. */
export const FILES_DRAG_TYPE = "application/x-otuken-files";

export interface FileLocation {
  root: string;
  path: string;
}

export const joinPath = (path: string, name: string) => [path, name].filter(Boolean).join("/");
export const parentOf = (path: string) => path.split("/").filter(Boolean).slice(0, -1).join("/");
export const nameOf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

const query = (params: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();

export const filesApi = {
  roots: () => api<FileRootsResponse>("/files/roots"),
  setSystemRoots: (systemRoots: boolean) =>
    api<{ systemRoots: boolean }>("/files/settings", { method: "PUT", body: { systemRoots } }),
  listPath: (location: FileLocation, hidden: boolean) =>
    `/files/list?${query({ ...location, hidden: hidden ? "true" : undefined })}`,
  list: (location: FileLocation, hidden = false) =>
    api<FileListing>(filesApi.listPath(location, hidden)),
  properties: (location: FileLocation) =>
    api<FileProperties>(`/files/properties?${query({ ...location })}`),
  search: (location: FileLocation, q: string) =>
    api<FileSearchResult>(`/files/search?${query({ ...location, q })}`),
  readText: (location: FileLocation) => api<TextFile>(`/files/text?${query({ ...location })}`),
  writeText: (location: FileLocation, content: string, etag: string | null) =>
    api<TextFile>("/files/text", { method: "PUT", body: { ...location, content, etag } }),
  mkdir: (location: FileLocation, name: string) =>
    api<void>("/files/mkdir", { method: "POST", body: { ...location, name } }),
  rename: (location: FileLocation, name: string) =>
    api<void>("/files/rename", { method: "POST", body: { ...location, name } }),
  copy: (root: string, paths: string[], destination: FileLocation, name?: string) =>
    api<void>("/files/copy", {
      method: "POST",
      body: { root, paths, destination, ...(name ? { name } : {}) },
    }),
  move: (root: string, paths: string[], destination: FileLocation) =>
    api<void>("/files/move", { method: "POST", body: { root, paths, destination } }),
  remove: (root: string, paths: string[]) =>
    api<void>("/files/delete", { method: "POST", body: { root, paths, confirm: true } }),
  uploadPath: (location: FileLocation, name: string, overwrite: boolean) =>
    `/files/upload?${query({ ...location, name, overwrite: overwrite ? "true" : undefined })}`,
  downloadUrl: (location: FileLocation, inline = false) =>
    `/api/files/download?${query({ ...location, inline: inline ? "true" : undefined })}`,
};

/**
 * Bumped after every change made from this tab (Files windows, the desktop,
 * the shelf), so every view of a folder lists it again.
 */
export const useFilesRevision = create<number>()(() => 0);
export const filesChanged = () => useFilesRevision.setState((n) => n + 1, true);

/** "rapor.pdf" → "rapor (2).pdf" for the n-th attempt (n ≥ 2) when a name is taken. */
export function numberedName(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Uploads without ever overwriting: a taken name gets a number, like the Finder does. */
export async function uploadUnique(
  into: FileLocation,
  file: File,
  progress: (loaded: number, total: number) => void,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const name = numberedName(file.name, attempt);
    try {
      await uploadWithProgress(filesApi.uploadPath(into, name, false), file, progress);
      return name;
    } catch (caught) {
      if (!(caught instanceof ApiRequestError && caught.code === "CONFLICT") || attempt >= 20)
        throw caught;
    }
  }
}

/** Cut/copy between Files windows (one clipboard per tab). */
export const useFileClipboard = create<{
  mode: "copy" | "cut";
  root: string;
  paths: string[];
} | null>()(() => null);

const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown json jsonc yml yaml toml ini conf cfg cnf env properties log csv tsv xml html htm css scss " +
    "js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php pl lua sh bash zsh fish sql graphql " +
    "service timer socket mount target path rules nginx caddyfile dockerfile gitignore editorconfig"
  ).split(" "),
);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "xz", "bz2", "7z", "zst", "rar"]);

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export type FileKind = "folder" | "text" | "image" | "archive" | "link" | "file" | "other";

/** Whether an entry behaves as a folder (directories and links to folders inside the root). */
export function isFolder(entry: Pick<FileEntry, "type" | "link">): boolean {
  return (
    entry.type === "directory" || (entry.link?.inside === true && entry.link.type === "directory")
  );
}

export function kindOf(entry: Pick<FileEntry, "name" | "type" | "link">): FileKind {
  if (isFolder(entry)) return "folder";
  if (entry.type === "symlink" && !(entry.link?.inside && entry.link.type === "file"))
    return "link";
  if (entry.type === "other") return "other";
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  // Dot files and extension-less names (Dockerfile, .bashrc) are usually text.
  if (TEXT_EXTENSIONS.has(extension) || extension === "" || entry.name.startsWith("."))
    return "text";
  return "file";
}

/** "Rapor (kopya)", "Rapor (kopya 2)", … keeping the extension. */
export function copyName(name: string, taken: ReadonlySet<string>, suffix: string): string {
  const extension = extensionOf(name);
  const base = extension && !name.startsWith(".") ? name.slice(0, -(extension.length + 1)) : name;
  const ext = extension && !name.startsWith(".") ? `.${extension}` : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base} (${suffix}${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${suffix} ${Date.now()})${ext}`;
}

/** First free "Yeni klasör", "Yeni klasör 2", … */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return `${base} ${Date.now()}`;
}
