import "@excalidraw/excalidraw/index.css";
import {
  Excalidraw,
  exportToBlob,
  exportToSvg,
  getSceneVersion,
  loadFromBlob,
  MainMenu,
  serializeAsJSON,
  serializeLibraryAsJSON,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { useMemo, useRef } from "react";
import type { CanvasController, CanvasModule, CanvasProps } from "./canvas-types.ts";

/*
 * Excalidraw (MIT) as the drawing surface: infinite canvas, pen, shapes, text, arrows that connect
 * shapes, selection, undo and redo, zoom and pan. Loaded on demand; the app talks to it through
 * CanvasController only.
 */

/** Excalidraw's own language codes for EveryOS's languages. */
const LANGUAGES: Record<string, string> = {
  en: "en",
  tr: "tr-TR",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  ru: "ru-RU",
  zh: "zh-CN",
};

function initialData(
  scene: string | null,
  library: string | null,
): ExcalidrawInitialDataState | null {
  const parsed = scene ? (JSON.parse(scene) as ExcalidrawInitialDataState) : null;
  const libraryItems = library
    ? ((JSON.parse(library) as { libraryItems?: ExcalidrawInitialDataState["libraryItems"] })
        .libraryItems ?? [])
    : [];
  return {
    elements: parsed?.elements ?? [],
    appState: { ...(parsed?.appState ?? {}), collaborators: new Map() },
    files: parsed?.files ?? {},
    scrollToContent: true,
    libraryItems,
  };
}

function Canvas({
  scene,
  library,
  theme,
  locale,
  name,
  labels,
  onReady,
  onChange,
  onLibrary,
}: CanvasProps) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const data = useMemo(() => initialData(scene, library), []);
  const controller = useMemo<CanvasController>(
    () => ({
      serialize: () => {
        const current = api.current!;
        return serializeAsJSON(
          current.getSceneElementsIncludingDeleted(),
          current.getAppState(),
          current.getFiles(),
          "local",
        );
      },
      version: () => {
        const current = api.current;
        if (!current) return "";
        const state = current.getAppState();
        return `${getSceneVersion(current.getSceneElementsIncludingDeleted())}|${Object.keys(current.getFiles()).length}|${state.viewBackgroundColor}|${state.gridModeEnabled}`;
      },
      isEmpty: () => (api.current?.getSceneElements().length ?? 0) === 0,
      exportPng: async () => {
        const current = api.current!;
        const blob = await exportToBlob({
          elements: current.getSceneElements(),
          appState: { ...current.getAppState(), exportBackground: true, exportEmbedScene: true },
          files: current.getFiles(),
          mimeType: "image/png",
          exportPadding: 16,
        });
        return new Uint8Array(await blob.arrayBuffer());
      },
      exportSvg: async () => {
        const current = api.current!;
        const svg = await exportToSvg({
          elements: current.getSceneElements(),
          appState: { ...current.getAppState(), exportBackground: true, exportEmbedScene: true },
          files: current.getFiles(),
          exportPadding: 16,
        });
        return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}\n`;
      },
    }),
    [],
  );

  return (
    <div className="wb-canvas" aria-label={labels.canvas}>
      <Excalidraw
        excalidrawAPI={(value: ExcalidrawImperativeAPI) => {
          api.current = value;
          onReady(controller);
        }}
        initialData={data}
        name={name}
        theme={theme}
        langCode={LANGUAGES[locale.slice(0, 2)] ?? "en"}
        aiEnabled={false}
        validateEmbeddable={false}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            toggleTheme: false,
            changeViewBackgroundColor: true,
            clearCanvas: true,
          },
          // Pictures come in through EveryOS's file picker only (Import), not the browser's.
          tools: { image: false },
        }}
        onChange={() => onChange()}
        onLibraryChange={(items: LibraryItems) => onLibrary(serializeLibraryAsJSON(items))}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint />
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.HelpHint />
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>{labels.welcome}</WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}

/** A board file (.excalidraw, Excalidraw JSON, or a PNG or SVG with the scene inside) as a scene. */
async function importScene(bytes: Uint8Array, fileName: string): Promise<string> {
  const lower = fileName.toLowerCase();
  const type = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".svg")
      ? "image/svg+xml"
      : "application/json";
  const restored = await loadFromBlob(new Blob([bytes as BlobPart], { type }), null, null);
  return serializeAsJSON(restored.elements, restored.appState, restored.files, "local");
}

export const canvasModule: CanvasModule = { Canvas, importScene };
