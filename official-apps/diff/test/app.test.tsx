import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { byRole, byText, pressKey } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffApp } from "../src/diff-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const settle = () => new Promise((resolve) => setTimeout(resolve));

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(DiffApp, {
    publicDir,
    app: { id: "dev.everyos.diff", version: "1.0.0", name: "Diff Viewer" },
    granted: ["storage:app", "clipboard:write", "files:pick", "files:save"],
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  await settle();
  return rendered;
}

/** The editor of a side: in the side-by-side view A and B, inline only B. */
function side(which: "a" | "b"): EditorView {
  const element = document.querySelector<HTMLElement>(
    which === "a" ? ".cm-merge-a" : ".cm-merge-b",
  );
  if (!element) throw new Error(`No editor for side ${which}`);
  return EditorView.findFromDOM(element)!;
}
function type(which: "a" | "b", text: string) {
  const view = side(which);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}
const status = () => document.querySelector(".diff-status")?.textContent ?? "";
const position = () => document.querySelector(".diff-position")?.textContent ?? "";
async function click(name: string | RegExp, role = "button") {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  await settle();
  byRole(role, name)!.click();
}

const OLD = [
  'import { greet } from "./greet";',
  "",
  "export function main() {",
  '  greet("world");',
  "}",
  "",
  "// helpers",
  "const a = 1;",
  "const b = 2;",
  "const c = 3;",
  "const d = 4;",
  "const e = 5;",
  "const f = 6;",
  "const g = 7;",
  "",
].join("\n");
const NEW = OLD.replace('greet("world")', 'greet("EveryOS")').replace(
  "const g = 7;",
  "const g = 7;\nconst h = 8;",
);

describe("Diff Viewer", () => {
  it("compares typed text side by side and keeps it for next time", async () => {
    const { host } = await start();
    expect(status()).toBe("Nothing to compare yet");
    type("a", "alpha\nbeta\ngamma");
    type("b", "alpha\nBETA\ngamma\ndelta");
    // "gamma" had no final line break, so appending "delta" changes it too (as in git).
    // Lines 2 and 3 are next to each other: one change.
    await vi.waitFor(() => expect(status()).toMatch(/^\+3−2/));
    expect(position()).toBe("1 change");
    await vi.waitFor(() =>
      expect(host.storage.get("right")).toEqual({
        name: null,
        text: "alpha\nBETA\ngamma\ndelta",
        ending: null,
      }),
    );
    // Identical after editing back; closing the window right away still keeps the last edit.
    type("b", "alpha\nbeta\ngamma");
    await vi.waitFor(() => expect(status()).toBe("Identical"));
    window.dispatchEvent(new Event("pagehide"));
    // Sooner than the 400 ms pause after typing: only the flush on pagehide can have written it.
    await vi.waitFor(
      () => expect((host.storage.get("right") as { text: string }).text).toBe("alpha\nbeta\ngamma"),
      { timeout: 200, interval: 10 },
    );

    const storage = Object.fromEntries(host.storage);
    rendered!.unmount();
    rendered = null;
    await start({ storage });
    expect(side("a").state.doc.toString()).toBe("alpha\nbeta\ngamma");
    expect(side("b").state.doc.toString()).toBe("alpha\nbeta\ngamma");
  });

  it("compares two files, highlights them, moves between changes and saves a patch", async () => {
    const { host } = await start({
      files: { "/work/main.old.ts": OLD, "/work/main.ts": NEW },
      pick: (() => {
        const picks = [["/work/main.old.ts"], ["/work/main.ts"]];
        return () => picks.shift() ?? null;
      })(),
    });
    await click("Open the original file…");
    await vi.waitFor(() => expect(byText("main.old.ts")).not.toBeNull());
    await click("Open the changed file…");
    await vi.waitFor(() => expect(byText("main.ts")).not.toBeNull());
    await vi.waitFor(() => expect(position()).toBe("2 changes"));
    expect(status()).toMatch(/^\+2−1/);
    expect(byText("Automatic (TypeScript)", "option")).not.toBeNull();
    // TypeScript highlighting is loaded for both sides.
    await vi.waitFor(() => expect(side("a").state.facet(language)?.name).toBe("typescript"));
    expect(side("b").state.facet(language)?.name).toBe("typescript");

    await click("Next change (F7)");
    await vi.waitFor(() => expect(position()).toBe("1 of 2"));
    await click("Next change (F7)");
    await vi.waitFor(() => expect(position()).toBe("2 of 2"));
    pressKey("F7", {}, window);
    await vi.waitFor(() => expect(position()).toBe("1 of 2"));
    pressKey("F7", { shift: true }, window);
    await vi.waitFor(() => expect(position()).toBe("2 of 2"));

    await click("Save patch…");
    await vi.waitFor(() => expect(host.readText("/main.patch")).toContain("+++ b/main.ts"));
    const patch = host.readText("/main.patch")!;
    expect(patch).toContain("--- a/main.old.ts\n+++ b/main.ts\n@@ -1,7 +1,7 @@");
    expect(patch).toContain('-  greet("world");\n+  greet("EveryOS");');
    expect(patch).toContain(" const g = 7;\n+const h = 8;\n");
    await click("Copy patch");
    await vi.waitFor(() => expect(host.clipboard).toEqual([patch]));
  });

  it("ignores whitespace on request", async () => {
    await start();
    type("a", "if (ready) {\n  run();\n}");
    type("b", "if (ready) {\n\trun( );\n}");
    await vi.waitFor(() => expect(position()).toBe("1 change"));
    await click("Ignore whitespace", "switch");
    await vi.waitFor(() => expect(status()).toBe("Only whitespace differs"));
    expect(position()).toBe("");
    type("b", "if (ready) {\n\trun(fast);\n}");
    await vi.waitFor(() => expect(position()).toBe("1 change"));
  });

  it("shows changes inline with the removed text above the new", async () => {
    const { host } = await start({
      storage: {
        left: { name: "a.txt", text: "one\ntwo\nthree", ending: "LF" },
        right: { name: "b.txt", text: "one\n2\nthree", ending: "CRLF" },
      },
    });
    await click("Inline", "tab");
    await vi.waitFor(() => expect(document.querySelector(".cm-deletedChunk")).not.toBeNull());
    expect(document.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(document.querySelector(".cm-deletedChunk")!.textContent).toContain("two");
    expect(document.querySelector(".cm-merge-b .cm-changedLine")!.textContent).toBe("2");
    expect(byText(/Line endings differ \(LF \/ CRLF\)/)).not.toBeNull();
    await vi.waitFor(() => expect(host.storage.get("mode")).toBe("inline"));
    // Editing the changed side still works inline.
    type("b", "one\ntwo\nthree");
    await vi.waitFor(() => expect(status()).toBe("Identical"));
  });

  it("swaps sides and starts over", async () => {
    await start({
      storage: {
        left: { name: "old.txt", text: "x", ending: null },
        right: { name: "new.txt", text: "y", ending: null },
      },
    });
    await click("Swap sides");
    await vi.waitFor(() => expect(side("a").state.doc.toString()).toBe("y"));
    expect(side("b").state.doc.toString()).toBe("x");
    expect(document.querySelector('[data-side="left"] .diff-side-name')!.textContent).toBe(
      "new.txt",
    );
    await click("New comparison");
    await vi.waitFor(() => expect(status()).toBe("Nothing to compare yet"));
    expect(side("a").state.doc.toString()).toBe("");
    expect(document.querySelector('[data-side="left"] .diff-side-name')!.textContent).toBe(
      "Typed text",
    );
  });

  it("refuses binary and oversized files", async () => {
    await start({
      locale: "tr",
      files: { "/image.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]) },
    });
    await click("Özgün dosyayı aç…");
    await vi.waitFor(() => expect(byText("“image.png” bir metin dosyası değil.")).not.toBeNull());
    expect(side("a").state.doc.toString()).toBe("");
    rendered!.unmount();
    rendered = null;
    await start({ files: { "/huge.log": "x".repeat(5 * 1024 * 1024 + 1) } });
    await click("Open the changed file…");
    await vi.waitFor(() => expect(byText(/The file is too large/)).not.toBeNull());
  });
});
