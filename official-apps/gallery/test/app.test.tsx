import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GalleryApp } from "../src/gallery-app.tsx";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32"/></svg>';
const files = { "/Photos/one.svg": svg, "/Photos/nested/two.svg": svg, "/outside.svg": svg };
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(GalleryApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["files:pick", "storage:app"],
    files,
    prompt: () => "Travel",
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "New album")).not.toBeNull());
  await new Promise((done) => setTimeout(done));
  return rendered;
}
async function click(name: string) {
  await vi.waitFor(() => {
    const button = byRole("button", name) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
  });
  byRole("button", name)!.click();
}
const cards = () => document.querySelectorAll(".gallery-photo");
async function createAndScan() {
  await click("New album");
  await vi.waitFor(() => expect(byRole("button", "Index approved folder")).not.toBeNull());
  await click("Index approved folder");
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
}
describe("Gallery", () => {
  it("indexes an approved directory, searches, favorites and bulk-removes album references only", async () => {
    const { host } = await start({ pick: () => ["/Photos"] });
    await createAndScan();
    expect(document.querySelector(".gallery-grid")!.textContent).not.toContain("outside.svg");
    await click("Add to favorites");
    byRole("checkbox", "Favorites only")!.click();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(byRole("button", "Remove favorite")).not.toBeNull();
    typeInto(byRole("searchbox", "Search image names and paths"), "missing");
    await vi.waitFor(() => expect(cards()).toHaveLength(0));
    typeInto(byRole("searchbox", "Search image names and paths"), "");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await click("Select this page");
    await click("Remove selected from album");
    await vi.waitFor(() => expect(cards()).toHaveLength(0));
    expect(host.readText("/Photos/one.svg")).toBe(svg);
    expect(host.readText("/Photos/nested/two.svg")).toBe(svg);
    expect(host.calls.some((call) => call.method === "files.write")).toBe(false);
  });
  it("restores album favorites across close and clears previews when the folder share is withdrawn", async () => {
    const { host } = await start({ pick: () => ["/Photos"] });
    await createAndScan();
    await click("Add to favorites");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(
        [...host.storage.entries()].some(
          ([key, value]) =>
            key.startsWith("album/") &&
            (value as { items?: { favorite: boolean }[] }).items?.some((item) => item.favorite),
        ),
      ).toBe(true),
    );
    const storage = Object.fromEntries(host.storage);
    const handles = host.persistentHandles();
    rendered!.unmount();
    rendered = null;
    await start({ storage, handles });
    await vi.waitFor(() => expect(byRole("button", "Remove favorite")).not.toBeNull());
    await vi.waitFor(() =>
      expect((byRole("button", "Preview one.svg") as HTMLButtonElement).disabled).toBe(false),
    );
    await click("Preview one.svg");
    await vi.waitFor(() => expect(document.querySelector(".image-canvas img")).not.toBeNull());
    rendered!.host.revoke(
      handles.filter((handle) => handle.kind === "directory").map((handle) => handle.id),
    );
    await vi.waitFor(() => expect(document.querySelector(".image-canvas img")).toBeNull());
    await vi.waitFor(() => expect(cards()).toHaveLength(0));
  });
  it("flushes a pending album edit before deleting its storage, preserving source files", async () => {
    const { host } = await start({ pick: () => ["/Photos"] });
    await createAndScan();
    await click("Add to favorites");
    await click("Delete album");
    await vi.waitFor(() => expect(byText("No albums yet")).not.toBeNull());
    await new Promise((done) => setTimeout(done, 450));
    expect([...host.storage.keys()].some((key) => key.startsWith("album/"))).toBe(false);
    expect(host.readText("/Photos/one.svg")).toBe(svg);
  });
});
