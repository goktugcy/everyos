import type { DirectoryEntry, EveryOSApp, FileHandle } from "@everyos/app-sdk";

/** A file or folder in the workspace; `path` is relative to the workspace folder ("src/a.ts"). */
export interface Entry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number | null;
}

/** A folder shows at most this many entries; the rest are counted. */
export const MAX_LISTED = 1000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then names in natural order (file2 before file10). */
export function sortEntries<T extends Pick<DirectoryEntry, "name" | "kind">>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : collator.compare(a.name, b.name),
  );
}

export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export type NameProblem = "empty" | "reserved" | "separator" | "tooLong" | "exists";

/** Why a new file or folder name cannot be used, or null. */
export function nameProblem(name: string, siblings: readonly string[] = []): NameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed === "." || trimmed === "..") return "reserved";
  if (/[\\/]/.test(trimmed) || trimmed.includes("\u0000")) return "separator";
  if (new TextEncoder().encode(trimmed).length > 255) return "tooLong";
  const lower = trimmed.toLowerCase();
  if (siblings.some((sibling) => sibling.toLowerCase() === lower)) return "exists";
  return null;
}

export class NameError extends Error {
  readonly problem: NameProblem;
  constructor(problem: NameProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** The folder the person opened as a workspace; everything goes through its handle. */
export class Workspace {
  readonly #app: EveryOSApp;
  readonly root: FileHandle;

  constructor(app: EveryOSApp, root: FileHandle) {
    this.#app = app;
    this.root = root;
  }

  get name(): string {
    return this.root.name;
  }

  get writable(): boolean {
    return this.root.writable;
  }

  async list(folder: string): Promise<{ entries: Entry[]; more: number }> {
    const sorted = sortEntries(await this.#app.files.list(this.root, folder));
    return {
      entries: sorted.slice(0, MAX_LISTED).map((entry) => ({
        name: entry.name,
        path: joinPath(folder, entry.name),
        kind: entry.kind,
        size: entry.size,
      })),
      more: Math.max(0, sorted.length - MAX_LISTED),
    };
  }

  file(path: string): Promise<FileHandle> {
    return this.#app.files.child(this.root, path);
  }

  /** Makes a new, empty file or folder; refuses names in use (EveryOS would hand those out). */
  async create(folder: string, name: string, kind: "file" | "directory"): Promise<Entry> {
    const siblings = (await this.#app.files.list(this.root, folder)).map((entry) => entry.name);
    const problem = nameProblem(name, siblings);
    if (problem) throw new NameError(problem);
    const path = joinPath(folder, name.trim());
    await this.#app.files.child(this.root, path, kind);
    return { name: name.trim(), path, kind, size: kind === "file" ? 0 : null };
  }
}
