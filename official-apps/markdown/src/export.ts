import { renderMarkdown } from "@everyos/app-ui/markdown";
import { highlight } from "./highlight.ts";

/** The preview's HTML (sanitized, code highlighted). */
export function renderPreview(source: string): string {
  return renderMarkdown(source, { highlight });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Styles of an exported page: readable on its own, light and dark, with code colors. */
const EXPORT_CSS = `
:root { color-scheme: light dark; --text: #111827; --muted: #4b5563; --line: #e5e7eb; --code: #f3f4f6; --accent: #2563eb;
  --kw: #8b3fd9; --str: #0a7d3c; --num: #b45309; --com: #6b7a90; --fn: #1d63c9; --tag: #be185d; --attr: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --text: #e5e7eb; --muted: #9ca3af; --line: #374151; --code: #1f2937; --accent: #60a5fa;
  --kw: #c792ea; --str: #a5e075; --num: #f7a865; --com: #8b9bb4; --fn: #82aaff; --tag: #ff8fb7; --attr: #ffcb8b; } }
body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.65 system-ui, sans-serif; color: var(--text); }
h1, h2, h3, h4 { line-height: 1.25; } a { color: var(--accent); } img { max-width: 100%; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; background: var(--code); padding: 0.1em 0.35em; border-radius: 5px; }
pre { background: var(--code); padding: 0.8rem 1rem; border-radius: 8px; overflow: auto; } pre code { background: none; padding: 0; }
blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 0.3rem 0.7rem; }
hr { border: 0; border-top: 1px solid var(--line); } li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.3em; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: var(--kw); } .hljs-string, .hljs-regexp { color: var(--str); }
.hljs-number, .hljs-literal { color: var(--num); } .hljs-comment, .hljs-quote, .hljs-meta { color: var(--com); font-style: italic; }
.hljs-title { color: var(--fn); } .hljs-tag, .hljs-name { color: var(--tag); } .hljs-attr, .hljs-attribute { color: var(--attr); }
`.trim();

/** A standalone HTML document of a Markdown text: no scripts, its own small stylesheet. */
export function exportHtml(source: string, title: string, lang: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${EXPORT_CSS}
</style>
</head>
<body>
${renderPreview(source)}
</body>
</html>
`;
}

export interface TextStats {
  words: number;
  characters: number;
  /** Minutes at 200 words a minute (at least 1 for any text). */
  minutes: number;
}

export function textStats(source: string): TextStats {
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  return {
    words,
    characters: [...source].length,
    minutes: words ? Math.max(1, Math.round(words / 200)) : 0,
  };
}
