import {
  getChunks,
  getOriginalDoc,
  goToNextChunk,
  goToPreviousChunk,
  MergeView,
  unifiedMergeView,
  type Chunk,
} from "@codemirror/merge";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { useI18n } from "@everyos/app-ui";
import { editorPhrases, editorSetup } from "@everyos/app-ui/editor";
import { useEffect, useRef, type RefObject } from "react";
import { chunkAt, diffConfig } from "./diff.ts";

export type ViewMode = "split" | "inline";

export interface SurfaceOptions {
  mode: ViewMode;
  ignoreWhitespace: boolean;
  collapse: boolean;
  wrap: boolean;
}

/** What the surface shows: its chunks, both documents and the chunk under the cursor. */
export interface DiffInfo {
  chunks: readonly Chunk[];
  a: Text;
  b: Text;
  current: number | null;
  precise: boolean;
}

export interface SurfaceControls {
  next(): void;
  previous(): void;
}

interface Views {
  /** The editors per side; in the inline view only B is an editor. */
  a: EditorView | null;
  b: EditorView;
  merge: MergeView | null;
  /** The side the person last worked in, for navigation and the current chunk. */
  side: "a" | "b";
}

/**
 * The comparison itself. Options and the initial texts are read when it mounts (the app remounts
 * it with a new key when they change); later edits are reported through `onLeft`/`onRight`.
 */
export function DiffSurface({
  left,
  right,
  options,
  language,
  labels,
  placeholders,
  onLeft,
  onRight,
  onInfo,
  controls,
}: {
  left: string;
  right: string;
  options: SurfaceOptions;
  language: Extension | null;
  labels: { a: string; b: string };
  placeholders: { a: string; b: string };
  onLeft: (text: string) => void;
  onRight: (text: string) => void;
  onInfo: (info: DiffInfo) => void;
  controls: RefObject<SurfaceControls | null>;
}) {
  const i18n = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const languageSlot = useRef(new Compartment());
  const views = useRef<Views | null>(null);
  const latest = useRef({ onLeft, onRight, onInfo, language });
  useEffect(() => {
    latest.current = { onLeft, onRight, onInfo, language };
  });

  useEffect(() => {
    const host = parent.current!;
    let scheduled = false;
    const report = () => {
      scheduled = false;
      const current = views.current;
      if (!current) return;
      const state = current.b.state;
      const field = getChunks(state);
      const chunks = field?.chunks ?? [];
      const a = current.a ? current.a.state.doc : getOriginalDoc(state);
      const focused = current.side === "a" && current.a ? current.a : current.b;
      latest.current.onInfo({
        chunks,
        a,
        b: state.doc,
        current: chunkAt(chunks, current.side, focused.state.selection.main.head),
        precise: chunks.every((chunk) => chunk.precise),
      });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(report);
    };
    const listen = (side: "a" | "b") =>
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          if (side === "a") latest.current.onLeft(text);
          else latest.current.onRight(text);
        }
        if (
          (update.selectionSet && update.transactions.some((tr) => tr.isUserEvent("select"))) ||
          update.focusChanged
        ) {
          if (update.view.hasFocus && views.current) views.current.side = side;
        }
        schedule();
      });
    const common = (side: "a" | "b", label: string): Extension => [
      editorSetup({ wrap: options.wrap, placeholder: placeholders[side] }),
      editorPhrases(i18n.locale),
      languageSlot.current.of(latest.current.language ?? []),
      EditorView.contentAttributes.of({ "aria-label": label }),
      listen(side),
    ];
    const collapse = options.collapse ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {};
    if (options.mode === "split") {
      const merge = new MergeView({
        a: { doc: left, extensions: common("a", labels.a) },
        b: { doc: right, extensions: common("b", labels.b) },
        parent: host,
        highlightChanges: true,
        gutter: true,
        ...collapse,
        diffConfig: diffConfig(options.ignoreWhitespace),
      });
      views.current = { a: merge.a, b: merge.b, merge, side: "b" };
    } else {
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: right,
          extensions: [
            common("b", labels.b),
            unifiedMergeView({
              original: left,
              mergeControls: false,
              highlightChanges: true,
              gutter: true,
              syntaxHighlightDeletions: true,
              ...collapse,
              diffConfig: diffConfig(options.ignoreWhitespace),
            }),
          ],
        }),
      });
      views.current = { a: null, b: view, merge: null, side: "b" };
    }
    const move = (command: typeof goToNextChunk) => {
      const current = views.current;
      if (!current) return;
      const view = current.side === "a" && current.a ? current.a : current.b;
      if (command(view)) schedule();
    };
    controls.current = { next: () => move(goToNextChunk), previous: () => move(goToPreviousChunk) };
    schedule();
    return () => {
      controls.current = null;
      if (views.current?.merge) views.current.merge.destroy();
      else views.current?.b.destroy();
      views.current = null;
    };
    // Mounted once per key: the app remounts the surface for new texts or options.
  }, []);

  // The language loads after the text is on screen; swap it in without rebuilding the view.
  useEffect(() => {
    const current = views.current;
    if (!current) return;
    const effects = languageSlot.current.reconfigure(language ?? []);
    current.b.dispatch({ effects });
    current.a?.dispatch({ effects });
  }, [language]);

  return <div ref={parent} className="diff-surface" data-mode={options.mode} />;
}
