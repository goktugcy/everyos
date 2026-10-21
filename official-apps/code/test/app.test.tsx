import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, pressKey } from "@everyos/app-testing/dom";
import { editorView, renderApp, typeInEditor, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeApp } from "../src/code-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const settle = () => new Promise((resolve) => setTimeout(resolve));

const FILES = {
  "/project/src/main.ts": "export const answer = 42;\r\n",
  "/project/src/util/helpers.ts": "export const add = (a: number, b: number) => a + b;\n",
  "/project/README.md": "# Project\n",
  "/project/package.json": '{ "name": "project" }\n',
  "/notes.txt": "first line\n",
};

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(CodeApp, {
    publicDir,
    app: { id: "dev.everyos.code", version: "1.0.0", name: "Code Editor" },
    granted: ["storage:app", "files:pick", "files:save"],
    files: FILES,
    pick: (request) => (request.directory ? ["/project"] : ["/notes.txt"]),
    ...options,
  });
  await vi.waitFor(() =>
    expect(document.querySelector(".code-app, [data-testid=empty-state]")).not.toBeNull(),
  );
  await settle();
  return rendered;
}

async function click(role: string, name: string | RegExp) {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  await settle();
  byRole(role, name)!.click();
}
const treeItems = () =>
  [...document.querySelectorAll(".code-tree-name")].map((item) => item.textContent);
const tabs = () => [...document.querySelectorAll(".code-tab-name")].map((tab) => tab.textContent);
const editorText = () => editorView(document.querySelector(".code-editors")!).state.doc.toString();

async function openProject() {
  await click("button", "Open folder…");
  await vi.waitFor(() => expect(treeItems()).toEqual(["src", "package.json", "README.md"]));
}

describe("Code Editor", () => {
  it("opens a folder, browses it and saves a file in place with its line endings", async () => {
    const { host } = await start();
    expect(byText("Open something to edit")).not.toBeNull();
    await openProject();
    expect(host.storage.get("workspace")).toMatch(/^h\d+$/);
    await click("treeitem", "src");
    await vi.waitFor(() =>
      expect(treeItems()).toEqual(["src", "util", "main.ts", "package.json", "README.md"]),
    );
    expect(byRole("treeitem", "src")!.getAttribute("aria-expanded")).toBe("true");
    await click("treeitem", "main.ts");
    await vi.waitFor(() => expect(tabs()).toEqual(["main.ts"]));
    await vi.waitFor(() => expect(editorText()).toBe("export const answer = 42;\n"));
    expect(byText("TypeScript (from the file name)", "option")).not.toBeNull();
    expect(byRole("treeitem", "main.ts")!.hasAttribute("data-active")).toBe(true);

    typeInEditor("// edited", { within: document.querySelector(".code-editors")! });
    await vi.waitFor(() => expect(tabs()).toEqual(["●main.ts"]));
    await vi.waitFor(() => expect(host.closeGuarded).toBe(true));
    pressKey("s", { mod: true }, window);
    await vi.waitFor(() => expect(tabs()).toEqual(["main.ts"]));
    expect(host.readText("/project/src/main.ts")).toBe("export const answer = 42;\r\n// edited");
    await vi.waitFor(() => expect(host.closeGuarded).toBe(false));
    expect(byText("Saved main.ts")).not.toBeNull();
  });

  it("moves through the tree with the keyboard", async () => {
    await start();
    await openProject();
    const first = byRole("treeitem", "src")!;
    first.focus();
    await settle();
    // Each key in a task of its own, as a person types them.
    pressKey("ArrowRight", {}, first);
    await vi.waitFor(() => expect(treeItems()).toContain("main.ts"));
    pressKey("ArrowDown", {}, first);
    await settle();
    pressKey("ArrowDown", {}, first);
    await vi.waitFor(() =>
      expect(byRole("treeitem", "main.ts")!.getAttribute("aria-selected")).toBe("true"),
    );
    await settle();
    pressKey("Enter", {}, first);
    await vi.waitFor(() => expect(tabs()).toEqual(["main.ts"]));
    pressKey("ArrowLeft", {}, first);
    await vi.waitFor(() =>
      expect(byRole("treeitem", "src")!.getAttribute("aria-selected")).toBe("true"),
    );
    await settle();
    pressKey("ArrowLeft", {}, first);
    await vi.waitFor(() => expect(treeItems()).toEqual(["src", "package.json", "README.md"]));
  });

  it("creates folders and files in the workspace, refusing names in use", async () => {
    const names = ["lib", "index.ts", "index.ts"];
    const { host } = await start({ prompt: () => names.shift() ?? null });
    await openProject();
    await click("treeitem", "src");
    await click("button", "New folder");
    await vi.waitFor(() => expect(treeItems()).toContain("lib"));
    expect(host.folders.has("/project/src/lib")).toBe(true);
    await click("treeitem", "lib");
    await click("button", "New file in folder");
    await vi.waitFor(() => expect(tabs()).toEqual(["index.ts"]));
    expect(host.readText("/project/src/lib/index.ts")).toBe("");
    expect(treeItems()).toContain("index.ts");
    await click("button", "New file in folder");
    await vi.waitFor(() => expect(byText("“index.ts” already exists here.")).not.toBeNull());
  });

  it("keeps unsaved work and the folder for the next session", async () => {
    const first = await start();
    await openProject();
    await click("treeitem", "README.md");
    await vi.waitFor(() => expect(tabs()).toEqual(["README.md"]));
    typeInEditor("More.\n", { within: document.querySelector(".code-editors")! });
    await click("button", "New file (Ctrl+N)");
    await vi.waitFor(() => expect(tabs()).toEqual(["●README.md", "Untitled 1"]));
    typeInEditor("scratch", { within: document.querySelector(".code-editor:not([hidden])")! });
    await vi.waitFor(() => expect(tabs()).toEqual(["●README.md", "●Untitled 1"]));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect([...first.host.storage.keys()].filter((key) => key.startsWith("doc/"))).toHaveLength(
        2,
      ),
    );
    const storage = Object.fromEntries(first.host.storage);
    const handles = first.host.persistentHandles();
    rendered!.unmount();
    rendered = null;

    const { host } = await start({ storage, handles });
    await vi.waitFor(() => expect(tabs()).toEqual(["●README.md", "●Untitled 1"]));
    expect(treeItems()).toEqual(["src", "package.json", "README.md"]);
    expect(editorText()).toBe("scratch");
    await click("tab", "●README.md");
    await vi.waitFor(() => expect(editorText()).toBe("# Project\nMore.\n"));
    // Still linked to its file: saving writes it in place.
    pressKey("s", { mod: true }, window);
    await vi.waitFor(() => expect(host.readText("/project/README.md")).toBe("# Project\nMore.\n"));
  });

  it("asks before replacing a file that changed elsewhere", async () => {
    let answer = false;
    const { host } = await start({ confirm: () => answer });
    await click("button", "Open file… (Ctrl+O)");
    await vi.waitFor(() => expect(tabs()).toEqual(["notes.txt"]));
    typeInEditor("mine\n", { within: document.querySelector(".code-editors")! });
    host.files.set("/notes.txt", { data: new TextEncoder().encode("theirs\n"), modifiedAt: 1 });
    await settle();
    pressKey("s", { mod: true }, window);
    await vi.waitFor(() =>
      expect(host.calls.some((call) => call.method === "dialog.confirm")).toBe(true),
    );
    await settle();
    expect(host.readText("/notes.txt")).toBe("theirs\n");
    expect(tabs()).toEqual(["●notes.txt"]);
    answer = true;
    pressKey("s", { mod: true }, window);
    await vi.waitFor(() => expect(host.readText("/notes.txt")).toBe("first line\nmine\n"));
  });

  it("refuses binary files and text in other encodings", async () => {
    await start({
      locale: "tr",
      files: {
        "/image.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]),
        "/legacy.txt": new Uint8Array([0x4b, 0x61, 0x72, 0xfd]),
      },
      pick: () => ["/image.png", "/legacy.txt"],
    });
    await click("button", "Dosya aç… (Ctrl+O)");
    await vi.waitFor(() => expect(byText("“image.png” bir metin dosyası değil.")).not.toBeNull());
    await vi.waitFor(() => expect(byText(/“legacy.txt” UTF-8 metin değil/)).not.toBeNull());
    expect(tabs()).toEqual([]);
  });

  it("applies settings: theme, indentation, minimap", async () => {
    const { host } = await start();
    await click("button", "New file (Ctrl+N)");
    await vi.waitFor(() => expect(document.querySelector(".cm-minimap-gutter")).not.toBeNull());
    await click("button", "Editor settings");
    const dialog = await vi.waitFor(() => {
      const element = byRole("dialog");
      expect(element).not.toBeNull();
      return element!;
    });
    const select = (label: string, value: string) => {
      const element = byRole("combobox", label) as HTMLSelectElement;
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    select("Theme", "dark");
    await vi.waitFor(() =>
      expect(document.querySelector(".code-editors")!.getAttribute("data-theme")).toBe("dark"),
    );
    select("Tab size", "4");
    await settle();
    byRole("checkbox", "Indent with spaces")!.click();
    await settle();
    byRole("checkbox", "Show the minimap")!.click();
    await vi.waitFor(() => expect(document.querySelector(".cm-minimap-gutter")).toBeNull());
    expect(dialog.isConnected).toBe(true);
    const view = editorView(document.querySelector(".code-editors")!);
    expect(view.state.facet(EditorState.tabSize)).toBe(4);
    expect(view.state.facet(indentUnit)).toBe("\t");
    expect(byText("Tab size: 4", "button")).not.toBeNull();
    await vi.waitFor(() =>
      expect(host.storage.get("settings")).toMatchObject({
        theme: "dark",
        tabSize: 4,
        insertSpaces: false,
        minimap: false,
      }),
    );
  });

  it("closes the folder when EveryOS withdraws access; open tabs keep their text", async () => {
    const { host } = await start({ saveAs: () => "/kept.ts" });
    await openProject();
    await click("treeitem", "src");
    await click("treeitem", "main.ts");
    await vi.waitFor(() => expect(tabs()).toEqual(["main.ts"]));
    host.revoke([host.storage.get("workspace") as string]);
    await vi.waitFor(() => expect(document.querySelector(".code-explorer")).toBeNull());
    await vi.waitFor(() => expect(tabs()).toEqual(["●main.ts"]));
    pressKey("s", { mod: true }, window);
    await vi.waitFor(() => expect(host.readText("/kept.ts")).toBe("export const answer = 42;\r\n"));
  });
});
