import type { MockHostOptions } from "@everyos/app-testing";
import { byRole } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagesApp } from "../src/images-app.tsx";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="red"/></svg>';
const files = { "/one.svg": svg, "/two.svg": svg.replace("red", "blue") };
const granted = ["files:pick", "files:save", "storage:app"];
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(ImagesApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted,
    files,
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "Open images")).not.toBeNull());
  await new Promise((done) => setTimeout(done));
  return rendered;
}
async function click(name: string) {
  await new Promise((done) => setTimeout(done));
  byRole("button", name)!.click();
}
describe("Image Viewer", () => {
  it("bounds streamed reads even when a selected file grew after it was picked", async () => {
    const { app } = await start();
    const [file] = await app.files.open({ accept: [".svg"] });
    await expect(app.files.read(file!, { maxBytes: 3 })).rejects.toThrow("too-large:3");
    expect(await app.files.read(file!, { maxBytes: 1000 })).toEqual(
      new TextEncoder().encode(svg).buffer,
    );
    await expect(app.files.read(file!, { maxBytes: -1 })).rejects.toThrow(
      "Invalid file read limit",
    );
  });
  it("opens selected files, transforms a preview and saves unchanged original bytes", async () => {
    const { host } = await start({ saveAs: () => "/copy.svg" });
    await click("Open images");
    await vi.waitFor(() => expect(document.querySelector('img[alt="one.svg"]')).not.toBeNull());
    await click("Zoom in");
    await click("Rotate right");
    expect(document.querySelector(".image-canvas")?.getAttribute("data-rotation")).toBe("90");
    expect(
      Number(document.querySelector(".image-canvas")?.getAttribute("data-zoom")),
    ).toBeGreaterThan(1);
    await click("Save original image");
    await vi.waitFor(() => expect(host.readText("/copy.svg")).toBe(svg));
    await click("Fit and reset");
    expect(document.querySelector(".image-canvas")?.getAttribute("data-rotation")).toBe("0");
    await click("Next image");
    await vi.waitFor(() => expect(document.querySelector('img[alt="two.svg"]')).not.toBeNull());
  });
  it("restores only persistent selected handles and the current image after close", async () => {
    const { host } = await start();
    await click("Open images");
    await vi.waitFor(() => expect(document.querySelector('img[alt="one.svg"]')).not.toBeNull());
    await click("Next image");
    await vi.waitFor(() => expect(document.querySelector('img[alt="two.svg"]')).not.toBeNull());
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(host.storage.has("images.v1")).toBe(true));
    const storage = Object.fromEntries(host.storage);
    const handles = host.persistentHandles();
    expect(JSON.stringify(storage)).not.toContain("blob:");
    expect(JSON.stringify(storage)).not.toContain("<svg");
    rendered!.unmount();
    rendered = null;
    await start({ storage, handles });
    await vi.waitFor(() => expect(document.querySelector('img[alt="two.svg"]')).not.toBeNull());
  });
  it("stops slideshow progression on suspend", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { host } = await start();
    await click("Open images");
    await vi.waitFor(() => expect(document.querySelector('img[alt="one.svg"]')).not.toBeNull());
    await click("Start slideshow");
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(document.querySelector('img[alt="two.svg"]')).not.toBeNull());
    host.emit("lifecycle.suspend", null);
    await new Promise((done) => setTimeout(done));
    await vi.advanceTimersByTimeAsync(15000);
    expect(document.querySelector('img[alt="two.svg"]')).not.toBeNull();
    expect(byRole("button", "Start slideshow")).not.toBeNull();
  });
  it("does not display a late file read after its share was revoked", async () => {
    const { app, host } = await start();
    let resolve: ((value: ArrayBuffer) => void) | undefined;
    vi.spyOn(app.files, "read").mockImplementation(
      () =>
        new Promise<ArrayBuffer>((done) => {
          resolve = done;
        }),
    );
    await click("Open images");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    host.revoke(host.persistentHandles().map((handle) => handle.id));
    resolve!(new TextEncoder().encode(svg).buffer);
    await vi.waitFor(() => expect(document.querySelector(".image-canvas img")).toBeNull());
    host.setGranted(["storage:app"]);
    await vi.waitFor(() =>
      expect((byRole("button", "Open images") as HTMLButtonElement).disabled).toBe(true),
    );
  });
});
