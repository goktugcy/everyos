import { renderApp, typeInEditor, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonApp } from "../src/json-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(JsonApp, {
    publicDir,
    app: { id: "dev.everyos.json", version: "1.0.0", name: "JSON Studio" },
    granted: ["storage:app", "files:pick", "files:save", "clipboard:write"],
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return rendered;
}
async function click(role: string, name: string | RegExp) {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  byRole(role, name)!.click();
}
const editorText = () => document.querySelector(".cm-content")?.textContent;

describe("JSON Studio", () => {
  it("validates as you type, points at errors and formats", async () => {
    await start();
    typeInEditor('{"b": 1, "a": [1, 2,]}');
    await vi.waitFor(() => expect(byText(/Line 1, column 21: Trailing comma/)).not.toBeNull());
    typeInEditor('{"b": 1, "a": [1, 2]}', { replace: true });
    await vi.waitFor(() => expect(byText("Valid JSON")).not.toBeNull());
    await click("switch", "Sort keys");
    await click("button", "Format");
    await vi.waitFor(() => expect(editorText()).toBe('{  "a": [    1,    2  ],  "b": 1}'));
    await click("button", "Minify");
    await vi.waitFor(() => expect(editorText()).toBe('{"a":[1,2],"b":1}'));
  });

  it("explores the tree, searches and copies paths", async () => {
    const { host } = await start({
      storage: {
        draft: { text: '{"user": {"name": "Ada", "langs": ["en", "tr"]}}', name: "x.json" },
      },
    });
    await vi.waitFor(() => expect(byRole("tree", "Document tree")).not.toBeNull());
    typeInto(byRole("searchbox") ?? document.querySelector("input[type=search]"), "tr");
    await vi.waitFor(() => expect(byText("1 of 1")).not.toBeNull());
    await vi.waitFor(() =>
      expect(document.querySelector(".json-path")?.textContent).toBe("$.user.langs[1]"),
    );
    await click("button", "Copy path");
    await vi.waitFor(() => expect(host.clipboard).toEqual(["$.user.langs[1]"]));
  });

  it("runs JSONPath queries", async () => {
    await start({
      storage: { draft: { text: '{"items": [{"n": 1}, {"n": 5}, {"n": 9}]}', name: "x.json" } },
    });
    await click("tab", "Query");
    const input = await vi.waitFor(() => {
      const field = document.querySelector<HTMLInputElement>(".json-query input");
      expect(field).not.toBeNull();
      return field!;
    });
    typeInto(input, "$.items[?(@.n > 3)].n");
    await vi.waitFor(() => expect(byText("2 results")).not.toBeNull());
    expect(
      [...document.querySelectorAll(".json-results span")].map((span) => span.textContent),
    ).toEqual(["5", "9"]);
  });

  it("compares two documents and exports CSV", async () => {
    const { host } = await start({
      storage: { draft: { text: '[{"a": 1, "b": "x"}, {"a": 2}]', name: "rows.json" } },
    });
    await click("tab", "Compare");
    await vi.waitFor(() => expect(byRole("textbox", "JSON to compare")).not.toBeNull());
    typeInto(byRole("textbox", "JSON to compare"), '[{"a": 1, "b": "y"}]');
    await vi.waitFor(() => expect(byText("1 changed")).not.toBeNull());
    expect(byText("1 removed")).not.toBeNull();
    await click("tab", "CSV");
    await vi.waitFor(() => expect(byText("2 rows, 2 columns")).not.toBeNull());
    await click("button", "Export CSV…");
    await vi.waitFor(() => expect(host.readText("/rows.csv")).toBe("a,b\r\n1,x\r\n2,\r\n"));
  });
});
