import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoApp } from "../src/video-app.tsx";
import { videoPreferences } from "../src/video.ts";

let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(VideoApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["files:pick", "storage:app"],
    files: { "/one.webm": new Uint8Array([1]), "/two.webm": new Uint8Array([2]) },
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "Add videos")).not.toBeNull());
  await new Promise((done) => setTimeout(done));
  return rendered;
}
async function click(name: string) {
  await new Promise((done) => setTimeout(done));
  expect(byRole("button", name)).not.toBeNull();
  byRole("button", name)!.click();
}
async function opened() {
  await click("Add videos");
  await vi.waitFor(() => expect(document.querySelector("video[src]")).not.toBeNull());
  return document.querySelector<HTMLVideoElement>("video")!;
}
function metadata(node: HTMLVideoElement, duration = 20) {
  Object.defineProperty(node, "duration", { configurable: true, value: duration });
  node.dispatchEvent(new Event("loadedmetadata"));
}
describe("Video Player", () => {
  it("keeps a full playlist intact and opens the requested file after choosing another list", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `old-${i}`);
    const { host } = await start({
      files: { "/new.mp4": new Uint8Array([1]) },
      handles: [{ id: "new", path: "/new.mp4", kind: "file", writable: false }],
      storage: {
        "video.v1": {
          lists: [
            { id: "full", name: "Full", ids },
            { id: "other", name: "Other", ids: [] },
          ],
          list: "full",
        },
      },
      state: {
        type: "everyos.file-open",
        requestId: "request",
        files: [{ id: "new", name: "new.mp4", kind: "file" }],
      },
    });
    await vi.waitFor(() => expect(byText(/This playlist is full/)).not.toBeNull());
    const selected = byRole("combobox", "Playlist") as HTMLSelectElement;
    selected.value = "other";
    selected.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("video[src]")).not.toBeNull());
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(
        videoPreferences(host.storage.get("video.v1")).lists.find((item) => item.id === "other")
          ?.ids,
      ).toEqual(["new"]),
    );
    expect(
      videoPreferences(host.storage.get("video.v1")).lists.find((item) => item.id === "full")?.ids,
    ).toEqual(ids);
  });
  it("opens an EveryOS-selected MP4 immediately and accepts another file in the same window without a picker", async () => {
    const first = {
      id: "first",
      name: "one.mp4",
      kind: "file",
      type: "video/mp4",
      size: 1,
      writable: false,
      persistent: true,
    };
    const { host } = await start({
      files: { "/one.mp4": new Uint8Array([1]), "/two.mp4": new Uint8Array([2]) },
      handles: [
        { id: "first", path: "/one.mp4", kind: "file", writable: false },
        { id: "second", path: "/two.mp4", kind: "file", writable: false },
      ],
      state: { type: "everyos.file-open", requestId: "first-request", files: [first] },
    });
    await vi.waitFor(() => expect(document.querySelector("video[src]")).not.toBeNull());
    const selected = () =>
      (byRole("combobox", "Selected video") as HTMLSelectElement).selectedOptions[0]?.textContent;
    expect(selected()).toBe("one.mp4");
    host.emit("window.opened", {
      state: {
        type: "everyos.file-open",
        requestId: "second-request",
        files: [{ ...first, id: "second", name: "two.mp4" }],
      },
    });
    await vi.waitFor(() => expect(selected()).toBe("two.mp4"));
    expect(
      host.calls.some((call) => call.method === "files.open" || call.method === "files.read"),
    ).toBe(false);
    expect((byRole("combobox", "Selected video") as HTMLSelectElement).options).toHaveLength(2);
  });
  it("streams selected video URLs without reading video bytes through the bridge", async () => {
    const { host } = await start();
    const node = await opened();
    metadata(node);
    expect(node.controls).toBe(true);
    expect(node.getAttribute("src")).toMatch(/blob:|data:/);
    expect(host.calls.some((call) => call.method === "files.read")).toBe(false);
    await click("Next video");
    await vi.waitFor(() =>
      expect(
        (byRole("combobox", "Selected video") as HTMLSelectElement).selectedOptions[0]?.textContent,
      ).toBe("two.webm"),
    );
    await click("Remove from playlist");
    await vi.waitFor(() =>
      expect((byRole("combobox", "Selected video") as HTMLSelectElement).options).toHaveLength(1),
    );
    expect(host.files.size).toBe(2);
  });
  it("persists a paused seek and restores native playback position and settings", async () => {
    const { host } = await start();
    const node = await opened();
    metadata(node);
    node.currentTime = 7;
    node.dispatchEvent(new Event("seeked"));
    node.pause();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(
        Object.values(videoPreferences(host.storage.get("video.v1")).positions).some(
          (position) => position.seconds === 7,
        ),
      ).toBe(true),
    );
    const storage = Object.fromEntries(host.storage);
    const handles = host.persistentHandles();
    expect(JSON.stringify(storage)).not.toContain("blob:");
    rendered!.unmount();
    rendered = null;
    await start({ storage, handles });
    await vi.waitFor(() => expect(document.querySelector("video[src]")).not.toBeNull());
    const again = document.querySelector<HTMLVideoElement>("video")!;
    metadata(again);
    expect(again.currentTime).toBe(7);
  });
  it("creates, renames and deletes named playlists without deleting source files", async () => {
    const names = ["Travel", "Travel 2026"];
    const { host } = await start({ prompt: () => names.shift() ?? null });
    await opened();
    await click("New playlist");
    await vi.waitFor(() => expect(byText("No video selected")).not.toBeNull());
    await click("Rename playlist");
    await vi.waitFor(() =>
      expect(
        (byRole("combobox", "Playlist") as HTMLSelectElement).selectedOptions[0]?.textContent,
      ).toBe("Travel 2026"),
    );
    await click("Delete playlist");
    await vi.waitFor(() =>
      expect((byRole("combobox", "Playlist") as HTMLSelectElement).options).toHaveLength(1),
    );
    expect(host.files.size).toBe(2);
  });
  it("explains decode failure and removes the player after permission revocation", async () => {
    const { host } = await start();
    const node = await opened();
    node.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(byText(/This file could not be played/)).not.toBeNull());
    host.setGranted(["storage:app"]);
    await vi.waitFor(() => expect(document.querySelector("video")).toBeNull());
    expect((byRole("button", "Add videos") as HTMLButtonElement).disabled).toBe(true);
  });
});
