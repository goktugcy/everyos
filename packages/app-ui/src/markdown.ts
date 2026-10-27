import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

/*
 * Markdown for official apps: CommonMark with tables, strikethrough and links, raw HTML off, and
 * the result sanitized again with DOMPurify before it reaches the page (defence in depth: the app
 * sandbox already keeps scripts from reaching EveryOS).
 */

const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

// Task lists: `- [ ] todo` / `- [x] done` become disabled checkboxes.
md.core.ruler.after("inline", "everyos-tasks", (state) => {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children?.length) continue;
    const first = token.children[0];
    if (first?.type !== "text") continue;
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${match[1] === " " ? "" : " checked"}> `;
    token.children.unshift(box);
  }
});

/**
 * Sanitized HTML for a Markdown text (links open outside the app). `highlight` colors fenced
 * code (return HTML of escaped code with `hljs-*` spans, e.g. from highlight.js; it is sanitized
 * with the rest).
 */
export function renderMarkdown(
  source: string,
  options: { highlight?: (code: string, language: string) => string | null } = {},
): string {
  md.set({
    highlight: options.highlight
      ? (code, language) => options.highlight!(code, language) ?? ""
      : null,
  });
  const html = md.render(source);
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed"],
  });
  return clean.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
}

export { markdownHeadings, markdownText, markdownTitle, type MarkdownHeading } from "./text.ts";
