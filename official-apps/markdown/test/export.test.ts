import { describe, expect, it } from "vitest";
import { exportHtml, renderPreview, textStats } from "../src/export.ts";
import { highlight } from "../src/highlight.ts";

describe("Markdown export", () => {
  it("renders tables, task lists and highlighted code, never scripts", () => {
    const html = renderPreview(
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>",
    );
    expect(html).toContain("<table>");
    expect(html).toContain('<input type="checkbox" disabled="" checked="">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).not.toContain("<script");
  });

  it("exports a standalone document with a title and its own styles", () => {
    const page = exportHtml("# Report <b>\n\nText", "Report <b>", "tr");
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<html lang="tr">');
    expect(page).toContain("<title>Report &#60;b&#62;</title>");
    expect(page).toContain("<style>");
    expect(page).not.toMatch(/<script/i);
  });

  it("highlights known languages only", () => {
    expect(highlight("SELECT 1", "sql")).toContain("hljs-keyword");
    expect(highlight("x", "py")).not.toBeNull();
    expect(highlight("x", "brainfuck")).toBeNull();
    expect(highlight("x", "")).toBeNull();
  });

  it("counts words, characters and reading time", () => {
    expect(textStats("")).toEqual({ words: 0, characters: 0, minutes: 0 });
    expect(textStats("# Hello world 😀")).toEqual({ words: 2, characters: 15, minutes: 1 });
    expect(textStats("word ".repeat(1000)).minutes).toBe(5);
  });
});
