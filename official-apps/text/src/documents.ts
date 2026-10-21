import type { EveryOSApp, FileHandle } from "@everyos/app-sdk";
import type { Encoding, LineEnding } from "./encoding.ts";

/*
 * Open documents and their recovery copies. Each tab's text is saved to storage as people type
 * (one value per tab; storage values hold 256 KiB, so larger texts keep only their file link), and
 * the list of tabs separately. After a reload, every tab comes back with its unsaved changes.
 */

export interface Doc {
  id: string;
  name: string;
  /** The file it was opened from or saved to (a persisted handle id). */
  handleId: string | null;
  text: string;
  /** The text as last read from or written to the file (unsaved changes differ from it). */
  savedText: string;
  encoding: Encoding;
  bom: boolean;
  eol: LineEnding;
  /** Encoding, mark and line endings as last read or written (changing them is a change too). */
  savedFormat: string;
}

export interface DocMeta extends Omit<Doc, "text" | "savedText"> {
  dirty: boolean;
  /** Too large for a recovery copy: only the file link is kept. */
  tooLarge: boolean;
}

/** Recovery copies are kept below this (characters; storage values hold 256 KiB of JSON). */
export const RECOVERY_LIMIT = 100_000;
/** Files above this are not opened (the editor stays fast). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const formatOf = (doc: Pick<Doc, "encoding" | "bom" | "eol">) =>
  `${doc.encoding}:${doc.bom}:${doc.eol}`;

export const isDirty = (doc: Doc) =>
  doc.text !== doc.savedText || formatOf(doc) !== doc.savedFormat;

export function newDoc(name: string, encoding: Encoding = "utf-8"): Doc {
  return {
    id: [...crypto.getRandomValues(new Uint8Array(8))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    name,
    handleId: null,
    text: "",
    savedText: "",
    encoding,
    bom: false,
    eol: "lf",
    savedFormat: formatOf({ encoding, bom: false, eol: "lf" }),
  };
}

export function metaOf(doc: Doc): DocMeta {
  const { text: _text, savedText: _saved, ...meta } = doc;
  return { ...meta, dirty: isDirty(doc), tooLarge: doc.text.length > RECOVERY_LIMIT };
}

export class Recovery {
  readonly #app: EveryOSApp;

  constructor(app: EveryOSApp) {
    this.#app = app;
  }

  async saveIndex(docs: readonly Doc[], active: string | null): Promise<void> {
    await this.#app.storage.set("tabs", { docs: docs.map(metaOf), active });
  }

  async saveDoc(doc: Doc): Promise<void> {
    if (doc.text.length > RECOVERY_LIMIT) {
      await this.#app.storage.delete(`doc/${doc.id}`);
      return;
    }
    // Clean documents with a file are read from the file again; only changes need a copy.
    if (!isDirty(doc) && doc.handleId) {
      await this.#app.storage.delete(`doc/${doc.id}`);
      return;
    }
    await this.#app.storage.set(`doc/${doc.id}`, doc.text);
  }

  async forget(id: string): Promise<void> {
    await this.#app.storage.delete(`doc/${id}`);
  }

  /**
   * The tabs of the last session: unsaved text from the recovery copies, clean files read again
   * through their handles (a handle no longer granted turns the tab into an unsaved copy).
   */
  async restore(
    read: (handle: FileHandle, meta: DocMeta) => Promise<{ text: string } | null>,
  ): Promise<{ docs: Doc[]; active: string | null; lost: string[] }> {
    const stored = await this.#app.storage.get<{ docs: DocMeta[]; active: string | null }>("tabs");
    if (!stored || !Array.isArray(stored.docs)) return { docs: [], active: null, lost: [] };
    const handles = new Map((await this.#app.files.handles()).map((handle) => [handle.id, handle]));
    const docs: Doc[] = [];
    const lost: string[] = [];
    for (const meta of stored.docs) {
      const handle = meta.handleId ? handles.get(meta.handleId) : undefined;
      const copy = await this.#app.storage.get<string>(`doc/${meta.id}`);
      const fromFile = handle ? await read(handle, meta).catch(() => null) : null;
      const savedText = fromFile?.text ?? "";
      const text = typeof copy === "string" ? copy : fromFile ? fromFile.text : null;
      if (text === null) {
        if (meta.dirty || meta.tooLarge) lost.push(meta.name);
        continue;
      }
      docs.push({
        id: meta.id,
        name: meta.name,
        handleId: handle ? meta.handleId : null,
        text,
        savedText: handle ? savedText : "",
        encoding: meta.encoding,
        bom: meta.bom,
        eol: meta.eol,
        savedFormat: handle ? meta.savedFormat : "",
      });
    }
    return {
      docs,
      active: docs.some((doc) => doc.id === stored.active) ? stored.active : (docs[0]?.id ?? null),
      lost,
    };
  }
}
