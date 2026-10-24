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

export interface MarkdownHeading {
  level: number;
  text: string;
  /** 0-based line of the heading in the source. */
  line: number;
}

/** The headings of a Markdown text (outlines), outside fenced code. */
export function markdownHeadings(source: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  source.split("\n").forEach((raw, line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (match)
      headings.push({
        level: match[1]!.length,
        text: match[2]!.replace(/[*_`~]/g, ""),
        line,
      });
  });
  return headings;
}
