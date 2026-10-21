import type { ComponentType } from "react";

/** What the app asks of the drawing surface (canvas.tsx is Excalidraw; tests use a fake). */
export interface CanvasController {
  /** The scene as Excalidraw JSON, images included. */
  serialize(): string;
  /** Changes whenever the drawing does (not when the person only scrolls or selects). */
  version(): string;
  isEmpty(): boolean;
  /** A PNG with the scene embedded (it can be imported again). */
  exportPng(): Promise<Uint8Array>;
  /** An SVG with the scene embedded. */
  exportSvg(): Promise<string>;
}

export interface CanvasProps {
  /** The board's stored scene, or null for a new board (read once, when the canvas mounts). */
  scene: string | null;
  /** The person's shape library (Excalidraw library JSON), or null. */
  library: string | null;
  theme: "light" | "dark";
  locale: string;
  name: string;
  labels: { canvas: string; welcome: string };
  onReady: (controller: CanvasController) => void;
  onChange: () => void;
  onLibrary: (json: string) => void;
}

export interface CanvasModule {
  Canvas: ComponentType<CanvasProps>;
  /** A board file's scene as Excalidraw JSON; throws when the file is not a board. */
  importScene: (bytes: Uint8Array, fileName: string) => Promise<string>;
}
