import { startWorker } from "@everyos/app-ui";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
// The viewer reads the library from `globalThis.pdfjsLib`, which the import above sets.
import {
  EventBus,
  FindState,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import type {
  FindQuery,
  OutlineItem,
  PdfEngine,
  PdfSession,
  SessionEvent,
  ZoomValue,
} from "./types.ts";

/*
 * pdf.js behind a small interface (types.ts): the app talks to a PdfSession and never to pdf.js
 * directly, so its interface is tested against a fake engine and the real one runs in the browser.
 */

/** Files pdf.js loads by name, copied into the package (`assets` in everyos.config.json). */
const resource = (path: string) => new URL(`pdfjs/${path}`, document.baseURI).href;

let worker: Promise<Worker> | null = null;

async function ensureWorker(): Promise<void> {
  // One worker for every document, started from the package (classic, from a blob URL).
  worker ??= startWorker("pdf.worker.js");
  pdfjs.GlobalWorkerOptions.workerPort = await worker;
}

function toOutline(
  items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>> | null,
): OutlineItem[] {
  return (items ?? []).map((item) => ({
    title: item.title,
    dest: item.dest,
    url: item.url ?? null,
    bold: item.bold,
    italic: item.italic,
    items: toOutline(item.items),
  }));
}

const FIND_STATES: Record<number, "found" | "notFound" | "wrapped" | "pending"> = {
  [FindState.FOUND]: "found",
  [FindState.NOT_FOUND]: "notFound",
  [FindState.WRAPPED]: "wrapped",
  [FindState.PENDING]: "pending",
};

export const engine: PdfEngine = {
  async open(data, container, { onPassword }) {
    await ensureWorker();
    const task = pdfjs.getDocument({
      data,
      cMapUrl: resource("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: resource("standard_fonts/"),
      wasmUrl: resource("wasm/"),
      iccUrl: resource("iccs/"),
      // The worker runs in an opaque origin: the page fetches these and hands them over.
      useWorkerFetch: false,
      enableXfa: false,
    });
    task.onPassword = (update: (password: string) => void, reason: number) => {
      void onPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "incorrect" : "need")
        .then((password) => {
          if (password === null) void task.destroy();
          else update(password);
        })
        .catch(() => void task.destroy());
    };
    const doc = await task.promise;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      removePageBorders: false,
    });
    linkService.setViewer(viewer);

    const listeners = new Set<(event: SessionEvent) => void>();
    const emit = (event: SessionEvent) => {
      for (const listener of listeners) listener(event);
    };
    // Listening before the document is set: the first events come right after.
    const pagesReady = new Promise<void>((resolve) => eventBus.on("pagesinit", () => resolve()));
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) =>
      emit({ kind: "page", page: pageNumber }),
    );
    eventBus.on("scalechanging", ({ scale }: { scale: number }) => emit({ kind: "scale", scale }));
    eventBus.on(
      "rotationchanging",
      ({ pagesRotation, pageNumber }: { pagesRotation: number; pageNumber: number }) => {
        // Rotating keeps the page in view (pdf.js's own viewer app does the same).
        viewer.currentPageNumber = pageNumber;
        emit({ kind: "rotation", rotation: pagesRotation });
      },
    );
    eventBus.on(
      "updatefindcontrolstate",
      ({
        state,
        matchesCount,
      }: {
        state: number;
        matchesCount?: { current: number; total: number };
      }) =>
        emit({
          kind: "find",
          state: FIND_STATES[state] ?? "pending",
          current: matchesCount?.current ?? 0,
          total: matchesCount?.total ?? 0,
        }),
    );
    eventBus.on(
      "updatefindmatchescount",
      ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
        emit({ kind: "matches", current: matchesCount.current, total: matchesCount.total }),
    );

    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    const [outline, metadata] = await Promise.all([
      doc.getOutline().catch(() => null),
      doc.getMetadata().catch(() => null),
      pagesReady,
    ]);
    viewer.currentScaleValue = "auto";
    const title = (metadata?.info as { Title?: unknown } | undefined)?.Title;

    const renderPage = async (pageNumber: number, scale: number, canvas: HTMLCanvasElement) => {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({
        scale,
        rotation: (page.rotate + viewer.pagesRotation) % 360,
      });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
    };

    let destroyed = false;
    const session: PdfSession = {
      pageCount: doc.numPages,
      fingerprint: doc.fingerprints[0] ?? `${doc.numPages}`,
      title: typeof title === "string" && title.trim() ? title.trim() : null,
      outline: toOutline(outline),
      get page() {
        return viewer.currentPageNumber;
      },
      get scale() {
        return viewer.currentScale;
      },
      get rotation() {
        return viewer.pagesRotation;
      },
      goTo(page) {
        viewer.currentPageNumber = Math.min(Math.max(1, Math.round(page)), doc.numPages);
      },
      async goToDestination(dest) {
        await linkService.goToDestination(dest as string);
      },
      setZoom(value: ZoomValue) {
        if (value === "in") viewer.increaseScale();
        else if (value === "out") viewer.decreaseScale();
        else viewer.currentScaleValue = typeof value === "number" ? String(value) : value;
      },
      setRotation(rotation) {
        viewer.pagesRotation = ((rotation % 360) + 360) % 360;
      },
      find(query: FindQuery, again) {
        eventBus.dispatch("find", {
          source: session,
          type: again ? "again" : "",
          query: query.text,
          caseSensitive: query.caseSensitive,
          entireWord: query.entireWord,
          highlightAll: true,
          findPrevious: again === "previous",
          matchDiacritics: false,
        });
      },
      clearFind() {
        eventBus.dispatch("findbarclose", { source: session });
      },
      async renderThumbnail(pageNumber, canvas, width) {
        const page = await doc.getPage(pageNumber);
        const base = page.getViewport({
          scale: 1,
          rotation: (page.rotate + viewer.pagesRotation) % 360,
        });
        await renderPage(pageNumber, width / base.width, canvas);
      },
      async renderForPrint(pageNumber, dpi) {
        const canvas = document.createElement("canvas");
        await renderPage(pageNumber, dpi / 72, canvas);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error("render");
        return blob;
      },
      hasFormChanges() {
        return doc.annotationStorage.size > 0;
      },
      async saveWithChanges() {
        return doc.saveDocument();
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        listeners.clear();
        viewer.setDocument(null);
        linkService.setDocument(null, null);
        // Ends the document's work in the worker (the worker itself serves the next one).
        void doc.loadingTask.destroy();
      },
    };
    return session;
  },
};
