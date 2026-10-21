import { renderApp, typeInEditor, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextApp } from "../src/text-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(TextApp, {
    publicDir,
    app: { id: "dev.everyos.text", version: "1.0.0", name: "Text Editor" },
    granted: ["storage:app", "files:pick", "files:save"],
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return rendered;
}

const editor = () => document.querySelector<HTMLElement>(".text-editor:not([hidden]) .cm-content")!;
const tabs = () => [...document.querySelectorAll(".text-tab-name")].map((tab) => tab.textContent);
async function click(name: string | RegExp) {
  await vi.waitFor(() => expect(byRole("button", name)).not.toBeNull());
  byRole("button", name)!.click();
}

const type = (text: string) => typeInEditor(text);

describe("Text Editor", () => {
  it("opens a file, edits it and saves it back in its encoding and line endings", async () => {
    const latin = new Uint8Array([0x4b, 0x61, 0x72, 0xfd, 0x0d, 0x0a]); // "Karı\r\n" in Windows-1254
    const { host } = await start({ locale: "tr", files: { "/docs/notlar.txt": latin } });
    await click("Aç…");
    await vi.waitFor(() => expect(tabs()).toContain("notlar.txt"));
    expect(editor().textContent).toBe("Karı");
    expect(byText("WINDOWS-1254")).not.toBeNull();
    type("ş");
    await vi.waitFor(() => expect(tabs()[0]).toBe("●notlar.txt"));
    await click("Kaydet");
    await vi.waitFor(() => expect(tabs()[0]).toBe("notlar.txt"));
    const saved = host.files.get("/docs/notlar.txt")!.data;
    expect([...saved]).toEqual([0x4b, 0x61, 0x72, 0xfd, 0x0d, 0x0a, 0xfe]);
  });

  it("saves a new document where the person chooses, and recovers unsaved work after a reload", async () => {
    const { host } = await start();
    type("draft one");
    await vi.waitFor(() => expect(tabs()[0]).toBe("●Untitled 1"));
    // Unsaved: kept for recovery.
    await vi.waitFor(() =>
      expect([...host.storage.keys()].some((key) => key.startsWith("doc/"))).toBe(true),
    );
    const storage = Object.fromEntries(host.storage);
    rendered!.unmount();
    rendered = null;
    const again = await start({ storage });
    await vi.waitFor(() => expect(editor().textContent).toBe("draft one"));
    expect(tabs()[0]).toBe("●Untitled 1");
    await click("Save");
    await vi.waitFor(() => expect(again.host.readText("/Untitled 1")).toBe("draft one"));
  });

  it("asks before closing a tab with unsaved changes", async () => {
    let asked = 0;
    await start({
      confirm: () => {
        asked += 1;
        return false;
      },
    });
    type("keep me");
    await vi.waitFor(() => expect(tabs()[0]).toBe("●Untitled 1"));
    await click("Close Untitled 1");
    await vi.waitFor(() => expect(asked).toBe(1));
    expect(tabs()).toEqual(["●Untitled 1"]);
  });

  it("refuses binary files", async () => {
    await start({ files: { "/photo.txt": new Uint8Array([0x89, 0x50, 0x00, 0x00]) } });
    await click("Open…");
    await vi.waitFor(() => expect(byText("photo.txt is not a text file.")).not.toBeNull());
  });
});
