import type { EveryOSApp } from "@everyos/app-sdk";

/*
 * Open files and their recovery copies. Each tab's unsaved text is kept in app storage as people
 * type (one value per tab; values hold 256 KiB, so larger texts keep only their file link), and
 * the tab list separately. After a reload every tab comes back, unsaved changes included.
 */

/** Where a tab's file lives: a file the person picked, or a path in a workspace folder. */
export type Source =
  { kind: "file"; handleId: string } | { kind: "workspace"; rootId: string; path: string };

export type Eol = "lf" | "crlf";

export interface Doc {
  id: string;
  name: string;
  source: Source | null;
  /** The text with "\n" line breaks (as the editor holds it). */
  text: string;
  /** The text as last read from or written to the file. */
  savedText: string;
  eol: Eol;
  savedEol: Eol;
  /** The file starts with a UTF-8 byte order mark (kept when saving). */
  bom: boolean;
  /** A language picked by hand ("plain" for none); null follows the file name. */
  language: string | null;
}

export interface DocMeta extends Omit<Doc, "text" | "savedText"> {
  dirty: boolean;
  tooLarge: boolean;
}

/** Recovery copies are kept below this many characters (storage values hold 256 KiB of JSON). */
export const RECOVERY_LIMIT = 100_000;
/** Larger files are not opened: the editor and the bridge stay fast. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const isDirty = (doc: Doc) => doc.text !== doc.savedText || doc.eol !== doc.savedEol;

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function newDoc(name: string): Doc {
  return {
    id: randomId(),
    name,
    source: null,
    text: "",
    savedText: "",
    eol: "lf",
    savedEol: "lf",
    bom: false,
    language: null,
  };
}

export class BinaryFileError extends Error {}
/** Not UTF-8: saving it back from here would change its bytes (the Text Editor reads others). */
export class EncodingError extends Error {}

export interface Decoded {
  text: string;
  eol: Eol;
  bom: boolean;
}

/** A file's bytes as editor text: strict UTF-8, line breaks as "\n", its style remembered. */
export function decodeFile(bytes: Uint8Array): Decoded {
  if (bytes.includes(0)) throw new BinaryFileError("binary");
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    throw new EncodingError("not-utf8");
  }
  return { text: raw.replace(/\r\n?/g, "\n"), eol: raw.includes("\r\n") ? "crlf" : "lf", bom };
}

/** The text to write: the file's line breaks and byte order mark. */
export const toDisk = (doc: Pick<Doc, "text" | "eol" | "bom">) =>
  (doc.bom ? "\uFEFF" : "") + (doc.eol === "crlf" ? doc.text.replace(/\n/g, "\r\n") : doc.text);

export function fromFile(name: string, source: Source, decoded: Decoded): Doc {
  return {
    ...newDoc(name),
    source,
    text: decoded.text,
    savedText: decoded.text,
    eol: decoded.eol,
    savedEol: decoded.eol,
    bom: decoded.bom,
  };
}

export const sameSource = (a: Source | null, b: Source | null) =>
  !!a &&
  !!b &&
  (a.kind === "file"
    ? b.kind === "file" && a.handleId === b.handleId
    : b.kind === "workspace" && a.rootId === b.rootId && a.path === b.path);

export function metaOf(doc: Doc): DocMeta {
  const { text: _text, savedText: _saved, ...meta } = doc;
  return { ...meta, dirty: isDirty(doc), tooLarge: doc.text.length > RECOVERY_LIMIT };
}

const isSource = (value: unknown): value is Source => {
  const source = value as Source | null;
  return (
    !!source &&
    ((source.kind === "file" && typeof source.handleId === "string") ||
      (source.kind === "workspace" &&
        typeof source.rootId === "string" &&
        typeof source.path === "string"))
  );
};

const isMeta = (value: unknown): value is DocMeta => {
  const meta = value as DocMeta | null;
  return (
    !!meta &&
    typeof meta.id === "string" &&
    typeof meta.name === "string" &&
    (meta.source === null || isSource(meta.source)) &&
    (meta.eol === "lf" || meta.eol === "crlf")
  );
};

export class Recovery {
  readonly #app: EveryOSApp;

  constructor(app: EveryOSApp) {
    this.#app = app;
  }

  async saveIndex(docs: readonly Doc[], active: string | null): Promise<void> {
    await this.#app.storage.set("tabs", { docs: docs.map(metaOf), active });
  }

  async saveDoc(doc: Doc): Promise<void> {
    // Clean files are read from the file again; too large ones keep only their link.
    if (doc.text.length > RECOVERY_LIMIT || (!isDirty(doc) && doc.source)) {
      await this.#app.storage.delete(`doc/${doc.id}`);
      return;
    }
    await this.#app.storage.set(`doc/${doc.id}`, doc.text);
  }

  async forget(id: string): Promise<void> {
    await this.#app.storage.delete(`doc/${id}`);
  }

  /**
   * The last session's tabs: unsaved text from recovery copies, clean files read again (`read`
   * returns null for a file no longer reachable, whose tab then becomes an unsaved copy).
   */
  async restore(
    read: (source: Source) => Promise<Decoded | null>,
  ): Promise<{ docs: Doc[]; active: string | null; lost: string[] }> {
    const stored = await this.#app.storage.get<{ docs: unknown[]; active: unknown }>("tabs");
    if (!stored || !Array.isArray(stored.docs)) return { docs: [], active: null, lost: [] };
    const docs: Doc[] = [];
    const lost: string[] = [];
    for (const meta of stored.docs) {
      if (!isMeta(meta)) continue;
      const copy = await this.#app.storage.get(`doc/${meta.id}`);
      const disk = meta.source ? await read(meta.source).catch(() => null) : null;
      const text = typeof copy === "string" ? copy : disk ? disk.text : null;
      if (text === null) {
        if (meta.dirty || meta.tooLarge) lost.push(meta.name);
        continue;
      }
      docs.push({
        id: meta.id,
        name: meta.name,
        source: disk ? meta.source : null,
        text,
        savedText: disk ? disk.text : "",
        eol: meta.eol,
        savedEol: disk ? disk.eol : meta.eol,
        bom: disk ? disk.bom : meta.bom === true,
        language: typeof meta.language === "string" ? meta.language : null,
      });
    }
    const active = typeof stored.active === "string" ? stored.active : null;
    return {
      docs,
      active: docs.some((doc) => doc.id === active) ? active : (docs[0]?.id ?? null),
      lost,
    };
  }
}
