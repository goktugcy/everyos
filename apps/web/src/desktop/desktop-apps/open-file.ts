import { randomId } from "../../lib/random-id.ts";
import type { FileLocation } from "../apps/files/lib.ts";
import { desktop } from "../state/controller.ts";
import { wm } from "../state/window-store.ts";
import { fileLaunches } from "./file-launches.ts";
import { activeDesktopApp, desktopAppWindowId } from "./store.ts";

export const isVideoFile = (name: string): boolean =>
  /\.(mp4|m4v|webm|ogv|mov|mkv|avi)$/i.test(name);

const ASSOCIATIONS: ReadonlyArray<{ app: string; extensions: readonly string[] }> = [
  { app: "video", extensions: ["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi"] },
  { app: "pdf", extensions: ["pdf"] },
  { app: "word", extensions: ["docx", "doc"] },
  { app: "excel", extensions: ["xlsx", "xls", "csv"] },
  { app: "images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"] },
  { app: "markdown", extensions: ["md", "markdown", "mdown"] },
  { app: "json", extensions: ["json", "geojson", "jsonl"] },
  { app: "calendar", extensions: ["ics", "ical", "ifb", "icalendar"] },
  { app: "whiteboard", extensions: ["excalidraw"] },
  {
    app: "text",
    extensions: [
      "txt",
      "text",
      "log",
      "tsv",
      "ini",
      "conf",
      "cfg",
      "cnf",
      "env",
      "properties",
      "srt",
      "vtt",
    ],
  },
  {
    app: "code",
    extensions: [
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "c",
      "h",
      "cpp",
      "hpp",
      "cs",
      "php",
      "pl",
      "lua",
      "sh",
      "bash",
      "zsh",
      "fish",
      "sql",
      "graphql",
      "jsonc",
      "yaml",
      "yml",
      "toml",
      "xml",
      "html",
      "htm",
      "css",
      "scss",
      "less",
      "patch",
      "diff",
      "service",
      "timer",
      "socket",
      "mount",
      "target",
      "path",
      "nginx",
      "dockerfile",
      "caddyfile",
      "gitignore",
      "editorconfig",
      "rules",
    ],
  },
];
const CODE_NAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "caddyfile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".bashrc",
  ".zshrc",
]);

/** Explicit associations for formats the official apps can actually read; no wildcard viewers. */
export function fileAppFor(name: string): string | null {
  const lower = name.toLowerCase();
  if (CODE_NAMES.has(lower)) return "dev.everyos.code";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const app = ASSOCIATIONS.find((entry) => entry.extensions.includes(lower.slice(dot + 1)))?.app;
  return app ? `dev.everyos.${app}` : null;
}

/** A file double-click is consent for this exact file, not for a path named by an app. */
export function openFileWithApp(location: FileLocation, appId: string): boolean {
  const app = activeDesktopApp(appId);
  const minimumVersion =
    appId === "dev.everyos.word" || appId === "dev.everyos.excel" ? "1.0.0" : "1.0.1";
  // Earlier official apps do not consume the file handoff; their Store dialog offers an update.
  if (
    !app ||
    app.registry?.kind !== "official" ||
    !isVersion(app.version) ||
    compareVersions(app.version, minimumVersion) < 0
  )
    return (
      desktop.openApp("everyos.store", {
        appState: {
          tab: "browse",
          desktopAppRequest: { appId, registryId: "official", requestId: randomId() },
        },
      }) !== null
    );
  const windowId = desktop.openApp(desktopAppWindowId(app.appId));
  if (!windowId) return false;
  const requestId = randomId();
  fileLaunches.queue(windowId, app.appId, requestId, location);
  wm().setAppState(windowId, { type: "everyos.file-open", requestId });
  return true;
}
import { compareVersions, isVersion } from "@everyos/app-manifest";
