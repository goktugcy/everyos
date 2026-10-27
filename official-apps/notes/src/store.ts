import type { EveryOSApp } from "@everyos/app-sdk";
import { markdownText, markdownTitle } from "@everyos/app-ui";

/*
 * Notes in the app's per-person storage. The note list is split over a few index shards (each
 * storage value holds at most 256 KiB), every note's text has its own key, and earlier versions are
 * kept per note. Deleted notes stay in the trash for 30 days.
 */

export interface NoteMeta {
  id: string;
  /** The first heading or line ("" for an empty note). */
  title: string;
  /** Plain text at the start of the note, for the list and search. */
  excerpt: string;
  folder: string | null;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Revision {
  at: number;
  text: string;
}

export interface Backup {
  format: "everyos-notes/1";
  exportedAt: number;
  folders: string[];
  notes: Array<NoteMeta & { text: string }>;
}

export const TRASH_MS = 30 * 86_400_000;
export const MAX_REVISIONS = 20;
/** A new version is kept when a note changes after this long. */
export const REVISION_GAP_MS = 2 * 60_000;
const SHARDS = 8;
const MAX_TEXT = 200_000;

const shardOf = (id: string) =>
  [...id].reduce((sum, char) => (sum + char.charCodeAt(0)) % SHARDS, 0);
const indexKey = (shard: number) => `index/${shard}`;
const bodyKey = (id: string) => `body/${id}`;
const revisionsKey = (id: string) => `revisions/${id}`;

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes]
    .map((byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function normalizeTags(input: string | readonly string[]): string[] {
  const list = typeof input === "string" ? input.split(/[,#\n]/) : input;
  return [
    ...new Set(list.map((tag) => tag.trim().replace(/\s+/g, "-").toLowerCase()).filter(Boolean)),
  ]
    .slice(0, 20)
    .map((tag) => tag.slice(0, 40));
}

function describe(text: string): Pick<NoteMeta, "title" | "excerpt"> {
  const title = markdownTitle(text, "");
  const plain = markdownText(text);
  const excerpt = (plain.startsWith(title) ? plain.slice(title.length) : plain)
    .trim()
    .slice(0, 160);
  return { title, excerpt };
}

function isNote(value: unknown): value is NoteMeta & { text: string } {
  const note = value as Partial<NoteMeta & { text: string }> | null;
  return (
    !!note &&
    typeof note.id === "string" &&
    /^[a-z0-9]{4,32}$/.test(note.id) &&
    typeof note.text === "string" &&
    Array.isArray(note.tags) &&
    typeof note.createdAt === "number" &&
    typeof note.updatedAt === "number"
  );
}

export class NotesStore {
  readonly #app: EveryOSApp;
  readonly #now: () => number;
  /** Index changes run one at a time, so two quick edits never undo each other. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(app: EveryOSApp, now: () => number = () => Date.now()) {
    this.#app = app;
    this.#now = now;
  }

  async #shard(shard: number): Promise<NoteMeta[]> {
    return (await this.#app.storage.get<NoteMeta[]>(indexKey(shard))) ?? [];
  }

  #serially(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Reads the shard again right before writing it: the widget writes to the same storage, and
   * reading late keeps the window from undoing what it added.
   */
  #mutate(id: string, change: (notes: NoteMeta[]) => NoteMeta[]): Promise<void> {
    return this.#serially(async () => {
      const shard = shardOf(id);
      await this.#app.storage.set(indexKey(shard), change(await this.#shard(shard)));
    });
  }

  #mutateAll(change: (note: NoteMeta) => NoteMeta): Promise<void> {
    return this.#serially(async () => {
      for (let shard = 0; shard < SHARDS; shard += 1) {
        const notes = await this.#shard(shard);
        const next = notes.map(change);
        if (next.some((note, index) => note !== notes[index]))
          await this.#app.storage.set(indexKey(shard), next);
      }
    });
  }

  /** Every note (with the trash), after removing what stayed in the trash for 30 days. */
  async list(): Promise<NoteMeta[]> {
    const shards = await Promise.all(
      Array.from({ length: SHARDS }, (_, shard) => this.#shard(shard)),
    );
    const now = this.#now();
    const expired = shards
      .flat()
      .filter((note) => note.deletedAt !== null && now - note.deletedAt > TRASH_MS);
    for (const note of expired) await this.destroy(note.id);
    return shards.flat().filter((note) => !expired.includes(note));
  }

  async read(id: string): Promise<string> {
    return (await this.#app.storage.get<string>(bodyKey(id))) ?? "";
  }

  async folders(): Promise<string[]> {
    return (await this.#app.storage.get<string[]>("folders")) ?? [];
  }

  async setFolders(folders: string[]): Promise<void> {
    const names = folders.map((folder) => folder.trim().slice(0, 80)).filter(Boolean);
    await this.#app.storage.set("folders", [...new Set(names)].slice(0, 200));
  }

  /** Renames a folder and moves its notes along; false when the new name is taken. */
  async renameFolder(from: string, to: string): Promise<boolean> {
    const name = to.trim().slice(0, 80);
    const folders = await this.folders();
    if (!name || (name !== from && folders.includes(name))) return false;
    await this.setFolders(folders.map((folder) => (folder === from ? name : folder)));
    await this.#mutateAll((note) => (note.folder === from ? { ...note, folder: name } : note));
    return true;
  }

  /** Deletes a folder; its notes stay, outside any folder. */
  async deleteFolder(name: string): Promise<void> {
    await this.setFolders((await this.folders()).filter((folder) => folder !== name));
    await this.#mutateAll((note) => (note.folder === name ? { ...note, folder: null } : note));
  }

  async create(
    input: { text?: string; folder?: string | null; tags?: string[]; pinned?: boolean } = {},
  ): Promise<NoteMeta> {
    const now = this.#now();
    const text = (input.text ?? "").slice(0, MAX_TEXT);
    const note: NoteMeta = {
      id: newId(),
      ...describe(text),
      folder: input.folder ?? null,
      tags: normalizeTags(input.tags ?? []),
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.#app.storage.set(bodyKey(note.id), text);
    await this.#mutate(note.id, (notes) => [...notes, note]);
    return note;
  }

  /** Saves a note's text; the text it replaces is kept as a version every few minutes. */
  async save(id: string, text: string): Promise<NoteMeta | null> {
    const now = this.#now();
    const next = text.slice(0, MAX_TEXT);
    const previous = await this.read(id);
    if (previous === next) return null;
    const revisions = await this.revisions(id);
    const last = revisions[0];
    if (previous && (!last || now - last.at >= REVISION_GAP_MS)) {
      let kept = [{ at: now, text: previous }, ...revisions].slice(0, MAX_REVISIONS);
      // Each storage value holds 256 KiB: older versions go first.
      while (kept.length > 1 && JSON.stringify(kept).length > 240_000) kept = kept.slice(0, -1);
      await this.#app.storage.set(revisionsKey(id), kept);
    }
    await this.#app.storage.set(bodyKey(id), next);
    let updated: NoteMeta | null = null;
    await this.#mutate(id, (notes) =>
      notes.map((note) =>
        note.id === id ? (updated = { ...note, ...describe(next), updatedAt: now }) : note,
      ),
    );
    return updated;
  }

  async update(
    id: string,
    patch: Partial<Pick<NoteMeta, "folder" | "tags" | "pinned">>,
  ): Promise<void> {
    const clean = { ...patch, ...(patch.tags ? { tags: normalizeTags(patch.tags) } : {}) };
    await this.#mutate(id, (notes) =>
      notes.map((note) => (note.id === id ? { ...note, ...clean, updatedAt: this.#now() } : note)),
    );
  }

  /** Moves a note to the trash (restorable for 30 days). */
  async remove(id: string): Promise<void> {
    await this.#mutate(id, (notes) =>
      notes.map((note) =>
        note.id === id ? { ...note, deletedAt: this.#now(), pinned: false } : note,
      ),
    );
  }

  async restore(id: string): Promise<void> {
    await this.#mutate(id, (notes) =>
      notes.map((note) => (note.id === id ? { ...note, deletedAt: null } : note)),
    );
  }

  /** Deletes a note for good, with its text and versions. */
  async destroy(id: string): Promise<void> {
    await this.#mutate(id, (notes) => notes.filter((note) => note.id !== id));
    await this.#app.storage.delete(bodyKey(id));
    await this.#app.storage.delete(revisionsKey(id));
  }

  async revisions(id: string): Promise<Revision[]> {
    return (await this.#app.storage.get<Revision[]>(revisionsKey(id))) ?? [];
  }

  /** Brings back an earlier version (the current text becomes a version itself). */
  async restoreRevision(id: string, at: number): Promise<string | null> {
    const revision = (await this.revisions(id)).find((entry) => entry.at === at);
    if (!revision) return null;
    const current = await this.read(id);
    const revisions = await this.revisions(id);
    await this.#app.storage.set(
      revisionsKey(id),
      [{ at: this.#now(), text: current }, ...revisions].slice(0, MAX_REVISIONS),
    );
    await this.#app.storage.set(bodyKey(id), revision.text);
    await this.#mutate(id, (notes) =>
      notes.map((note) =>
        note.id === id ? { ...note, ...describe(revision.text), updatedAt: this.#now() } : note,
      ),
    );
    return revision.text;
  }

  /** Markdown or text files become notes (in `folder`). */
  async importFiles(
    files: Array<{ name: string; text: string }>,
    folder: string | null = null,
  ): Promise<number> {
    for (const file of files) {
      const text = file.text.trim()
        ? file.text
        : `# ${file.name.replace(/\.(md|markdown|txt)$/i, "")}\n`;
      await this.create({ text, folder });
    }
    return files.length;
  }

  async exportAll(): Promise<Backup> {
    const notes = (await this.list()).filter((note) => note.deletedAt === null);
    return {
      format: "everyos-notes/1",
      exportedAt: this.#now(),
      folders: await this.folders(),
      notes: await Promise.all(
        notes.map(async (note) => ({ ...note, text: await this.read(note.id) })),
      ),
    };
  }

  /** Adds the notes of a backup (notes already here, by id, are skipped). */
  async importBackup(value: unknown): Promise<number> {
    const backup = value as Partial<Backup> | null;
    if (backup?.format !== "everyos-notes/1" || !Array.isArray(backup.notes))
      throw new SyntaxError("Not a Notes backup");
    const existing = new Set((await this.list()).map((note) => note.id));
    let added = 0;
    for (const note of backup.notes.filter(isNote)) {
      if (existing.has(note.id)) continue;
      const text = note.text.slice(0, MAX_TEXT);
      await this.#app.storage.set(bodyKey(note.id), text);
      const meta: NoteMeta = {
        id: note.id,
        ...describe(text),
        folder: typeof note.folder === "string" ? note.folder.slice(0, 80) : null,
        tags: normalizeTags(note.tags.filter((tag): tag is string => typeof tag === "string")),
        pinned: note.pinned === true,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        deletedAt: null,
      };
      await this.#mutate(note.id, (notes) => [...notes, meta]);
      added += 1;
    }
    if (Array.isArray(backup.folders))
      await this.setFolders([
        ...(await this.folders()),
        ...backup.folders.filter((f): f is string => typeof f === "string"),
      ]);
    return added;
  }
}
