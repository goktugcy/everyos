import "@everyos/app-ui/styles.css";
import "./whiteboard.css";
import { boot } from "@everyos/app-ui";
import { WhiteboardApp } from "./whiteboard-app.tsx";

// Excalidraw's fonts come from the package (`assets` in everyos.config.json), never from a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL(
  "./",
  document.baseURI,
).href;

void boot(WhiteboardApp);
