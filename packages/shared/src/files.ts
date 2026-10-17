/*
 * Zod-free file manager contracts (docs/files.md). Paths are always relative
 * to a configured root ("" is the root itself, segments separated by "/").
 */

/**
 * Standard folders in every user's home, always present (Finder's favourites).
 * The desktop shows the contents of "desktop".
 */
export const STANDARD_FOLDERS = [
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "music",
  "videos",
] as const;

export type StandardFolder = (typeof STANDARD_FOLDERS)[number];

/**
 * The user's private home, an administrator-configured location, a disk mounted from Settings
 * › Disks, or a read-only system path.
 */
export type FileRootKind = "home" | "location" | "disk" | "system";

export interface FileRootView {
  id: string;
  /** Location name; the username for a home; the absolute path for system roots. */
  name: string;
  kind: FileRootKind;
  /** Configured read-only, or the user lacks files:write. */
  readOnly: boolean;
  /** False when the configured directory is missing or unreadable. */
  available: boolean;
  /** Home only: where the standard folders are (relative paths). */
  folders?: Partial<Record<StandardFolder, string>>;
}

/** `GET /api/files/roots` */
export interface FileRootsResponse {
  roots: FileRootView[];
  /** Read-only Linux system locations for administrators (off unless enabled). */
  system: { enabled: boolean; canManage: boolean };
}

export type FileEntryType = "directory" | "file" | "symlink" | "other";

export interface FileEntry {
  name: string;
  type: FileEntryType;
  size: number;
  modifiedAt: number;
  /** "rwxr-xr-x" style permissions. */
  mode: string;
  /** Symlinks: what the link points to, if it stays inside the root. */
  link: { type: "directory" | "file" | "other"; inside: true } | { inside: false } | null;
}

export interface FileListing {
  root: string;
  path: string;
  entries: FileEntry[];
  /** More than the listing limit (5 000 entries). */
  truncated: boolean;
}

export interface FileProperties {
  root: string;
  path: string;
  name: string;
  type: FileEntryType;
  size: number;
  modifiedAt: number;
  changedAt: number;
  createdAt: number | null;
  mode: string;
  octal: string;
  owner: string;
  group: string;
  /** Directories: direct children (counted up to 10 000). */
  children: number | null;
  link: FileEntry["link"];
}

export interface TextFile {
  content: string;
  /** Opaque version; send it back when saving to detect concurrent changes. */
  etag: string;
  size: number;
  modifiedAt: number;
}

export interface FileSearchResult {
  results: Array<{ path: string; name: string; type: FileEntryType }>;
  truncated: boolean;
}

/** One item in the caller's private trash, retaining its original relative path. */
export interface TrashEntry {
  id: string;
  root: string;
  path: string;
  name: string;
  type: FileEntryType;
  size: number;
  deletedAt: number;
}

export interface TrashListing {
  entries: TrashEntry[];
  truncated: boolean;
}

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
