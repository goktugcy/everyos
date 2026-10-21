/*
 * Plain-text helpers for Markdown (titles, previews, search) without the renderer, so a widget or a
 * list can use them without bundling markdown-it and DOMPurify.
 */

/** The first heading or line of a Markdown text, as plain text (titles, previews). */
export function markdownTitle(source: string, fallback: string): string {
  for (const line of source.split("\n")) {
    const text = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/[*_`~>#[\]]/g, "")
      .trim();
    if (text) return text.slice(0, 120);
  }
  return fallback;
}

/** Plain text of a Markdown text (search and word counts). */
export function markdownText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>#|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
