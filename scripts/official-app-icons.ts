/*
 * Draws the icons of the official apps (official-apps/<slug>/public/icon.svg): the app's lucide
 * glyph in white on a rounded square of its colors, with EveryOS's soft top highlight.
 * Run: node scripts/official-app-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { OFFICIAL_APPS } from "./official-apps.config.ts";

const require = createRequire(join(import.meta.dirname, "../apps/web/package.json"));
// React and lucide come from the web app's dependencies (the root has none).
const { createElement } = require("react") as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = require("react-dom/server") as {
  renderToStaticMarkup: (element: unknown) => string;
};
const lucide = require("lucide-react") as Record<string, unknown>;

for (const app of OFFICIAL_APPS) {
  const Icon = lucide[app.icon];
  if (!Icon) throw new Error(`No lucide icon ${app.icon}`);
  const markup = renderToStaticMarkup(createElement(Icon, { size: 24, strokeWidth: 2 }));
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(markup)?.[1];
  if (!inner) throw new Error(`Could not read ${app.icon}`);
  const [top, bottom] = app.colors;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
    <linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#bg)"/>
  <rect x="4" y="4" width="120" height="62" rx="28" fill="url(#hl)"/>
  <g transform="translate(28 28) scale(3)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
</svg>
`;
  const dir = join(import.meta.dirname, "../official-apps", app.slug, "public");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "icon.svg"), svg);
}
process.stdout.write(`Drew ${OFFICIAL_APPS.length} icons\n`);
