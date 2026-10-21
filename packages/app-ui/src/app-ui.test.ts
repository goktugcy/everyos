// @vitest-environment happy-dom
import "@everyos/app-testing/setup";
import { createApp } from "@everyos/app-sdk";
import { mountMockHost } from "@everyos/app-testing";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AppProvider, createAppI18n } from "./app.tsx";
import { CodeEditor, languageNameFor, loadLanguage } from "./editor.tsx";
import { markdownHeadings, renderMarkdown } from "./markdown.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Markdown", () => {
  it("lists headings outside fenced code", () => {
    expect(
      markdownHeadings("# One\ntext\n```\n# not a heading\n```\n## Two **bold** ##\n   ### Three"),
    ).toEqual([
      { level: 1, text: "One", line: 0 },
      { level: 2, text: "Two bold", line: 5 },
      { level: 3, text: "Three", line: 6 },
    ]);
  });

  it("highlights fenced code and still sanitizes what the highlighter returns", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```", {
      highlight: (code, language) =>
        language === "js"
          ? `<span class="hljs-keyword">const</span>${code.slice(5)}<img src=x onerror=alert(1)>`
          : null,
    });
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).not.toContain("onerror");
    expect(renderMarkdown("```\nplain\n```")).toContain("plain");
  });
});

describe("CodeEditor", () => {
  let cleanup = () => undefined as void;
  afterEach(() => cleanup());

  it("edits text, takes new values from outside and loads languages on demand", async () => {
    const host = mountMockHost({ locale: "tr" });
    const app = await createApp();
    const i18n = await createAppI18n(app, ["en", "tr"], () => ({}));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      host.unmount();
    };
    const changes: string[] = [];
    let setOutside: (value: string) => void = () => undefined;
    function Harness() {
      const [value, setValue] = useState("hello");
      setOutside = setValue;
      return createElement(CodeEditor, {
        value,
        label: "Text",
        onChange: (next: string) => {
          changes.push(next);
          setValue(next);
        },
      });
    }
    await act(async () => {
      root.render(createElement(AppProvider, { app, i18n, children: createElement(Harness) }));
      await Promise.resolve();
    });
    const content = container.querySelector(".cm-content")!;
    expect(content.getAttribute("aria-label")).toBe("Text");
    expect(content.textContent).toBe("hello");
    act(() => setOutside("from outside"));
    expect(container.querySelector(".cm-content")!.textContent).toBe("from outside");
    expect(changes).toEqual([]);
    expect(await loadLanguage("script.ts")).not.toBeNull();
    expect(await loadLanguage("JSON")).not.toBeNull();
    expect(await loadLanguage("notes.unknownext")).toBeNull();
    expect(languageNameFor("src/app.tsx")).toBe("TSX");
    expect(languageNameFor("Dockerfile")).toBe("Dockerfile");
    expect(languageNameFor("styles.CSS")).toBe("CSS");
    expect(languageNameFor("notes.unknownext")).toBeNull();
    expect(languageNameFor(null)).toBeNull();
  });
});
