import { renderApp, typeInEditor, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownApp } from "../src/markdown-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(MarkdownApp, {
    publicDir,
    app: { id: "dev.everyos.markdown", version: "1.0.0", name: "Markdown Editor" },
    granted: ["storage:app", "files:pick", "files:save", "clipboard:write"],
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return rendered;
}
async function click(name: string | RegExp) {
  await vi.waitFor(() => expect(byRole("button", name)).not.toBeNull());
  byRole("button", name)!.click();
}
const preview = () => document.querySelector(".md-preview");

describe("Markdown Editor", () => {
  it("previews as you type and builds the outline", async () => {
    await start();
    typeInEditor("# Plan\n\n## Steps\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    await vi.waitFor(() => expect(preview()?.querySelector("h1")?.textContent).toBe("Plan"));
    expect(preview()?.querySelector("table")).not.toBeNull();
    await vi.waitFor(() => expect(byRole("button", "Steps")).not.toBeNull());
    byRole("button", "Steps")!.click();
  });

  it("opens a file, saves it back, and asks before discarding changes", async () => {
    let confirms = 0;
    const { host } = await start({
      files: { "/notes/plan.md": "# Old\r\n" },
      confirm: () => {
        confirms += 1;
        return false;
      },
    });
    await click("Open…");
    await vi.waitFor(() => expect(preview()?.querySelector("h1")?.textContent).toBe("Old"));
    typeInEditor("# New\n", { replace: true });
    await vi.waitFor(() => expect(byText("Unsaved changes")).not.toBeNull());
    await click("New document");
    await vi.waitFor(() => expect(confirms).toBe(1));
    expect(preview()?.querySelector("h1")?.textContent).toBe("New");
    await click("Save");
    await vi.waitFor(() => expect(host.readText("/notes/plan.md")).toBe("# New\n"));
    expect(byText("Unsaved changes")).toBeNull();
  });

  it("recovers the draft after a reload", async () => {
    const { host } = await start();
    typeInEditor("draft **text**");
    await vi.waitFor(() =>
      expect(host.storage.get("draft")).toMatchObject({ text: "draft **text**" }),
    );
    const storage = Object.fromEntries(host.storage);
    rendered!.unmount();
    rendered = null;
    await start({ storage });
    await vi.waitFor(() => expect(preview()?.querySelector("strong")?.textContent).toBe("text"));
  });

  it("exports HTML and copies it", async () => {
    const { host } = await start();
    typeInEditor("# Report\n\n```sql\nSELECT 1;\n```\n");
    await click("Export HTML…");
    await vi.waitFor(() => expect(host.readText("/Untitled.html")).toContain("<h1>Report</h1>"));
    expect(host.readText("/Untitled.html")).toContain("hljs-keyword");
    await click("Copy HTML");
    await vi.waitFor(() => expect(host.clipboard[0]).toContain("<h1>Report</h1>"));
  });
});
