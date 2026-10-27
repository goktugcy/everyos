/** The PDF engine as the app sees it (engine.ts is pdf.js; tests use a fake). */

/** A preset ("auto": fit the width up to 100 %) or a factor (1 = 100 %), or a step. */
export type ZoomValue = "auto" | "page-width" | "page-fit" | "page-actual" | "in" | "out" | number;

export interface OutlineItem {
  title: string;
  /** A destination inside the document (opaque, given back to `goToDestination`). */
  dest: unknown;
  /** A link out of the document. */
  url: string | null;
  bold: boolean;
  italic: boolean;
  items: OutlineItem[];
}

export interface FindQuery {
  text: string;
  caseSensitive: boolean;
  entireWord: boolean;
}

export type SessionEvent =
  | { kind: "page"; page: number }
  | { kind: "scale"; scale: number }
  | { kind: "rotation"; rotation: number }
  | {
      kind: "find";
      state: "found" | "notFound" | "wrapped" | "pending";
      current: number;
      total: number;
    }
  | { kind: "matches"; current: number; total: number };

export interface PdfSession {
  readonly pageCount: number;
  /** Identifies the document across files and sessions (pdf.js fingerprint). */
  readonly fingerprint: string;
  /** The document's own title, if it has one. */
  readonly title: string | null;
  readonly outline: OutlineItem[];
  readonly page: number;
  readonly scale: number;
  readonly rotation: number;
  goTo(page: number): void;
  goToDestination(dest: unknown): Promise<void>;
  setZoom(value: ZoomValue): void;
  setRotation(rotation: number): void;
  /** Starts a search, or moves to the next or previous match of the same one. */
  find(query: FindQuery, again?: "next" | "previous"): void;
  clearFind(): void;
  renderThumbnail(page: number, canvas: HTMLCanvasElement, width: number): Promise<void>;
  /** A page as a PNG at the given resolution, for printing. */
  renderForPrint(page: number, dpi: number): Promise<Blob>;
  /** Whether form fields were filled in. */
  hasFormChanges(): boolean;
  /** The document with the filled-in form fields. */
  saveWithChanges(): Promise<Uint8Array>;
  on(listener: (event: SessionEvent) => void): () => void;
  destroy(): void;
}

export interface OpenOptions {
  /** Asked when the document needs a password; null cancels. */
  onPassword: (reason: "need" | "incorrect") => Promise<string | null>;
}

export interface PdfEngine {
  /** Opens a document into `container` (an absolutely positioned, scrolling element). */
  open(data: Uint8Array, container: HTMLDivElement, options: OpenOptions): Promise<PdfSession>;
}
