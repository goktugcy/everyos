import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileAppFor, isVideoFile, openFileWithApp } from "./open-file.ts";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  open: vi.fn(),
  queue: vi.fn(),
  setState: vi.fn(),
}));
vi.mock("./store.ts", () => ({
  activeDesktopApp: mocks.active,
  desktopAppWindowId: (id: string) => `everyos.desktop.${id}`,
}));
vi.mock("../state/controller.ts", () => ({ desktop: { openApp: mocks.open } }));
vi.mock("../state/window-store.ts", () => ({ wm: () => ({ setAppState: mocks.setState }) }));
vi.mock("./file-launches.ts", () => ({ fileLaunches: { queue: mocks.queue } }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.active.mockReturnValue({
    appId: "dev.everyos.video",
    version: "1.0.1",
    registry: { kind: "official" },
  });
  mocks.open.mockReturnValue("player-window");
});
describe("default file opener", () => {
  it.each([
    ["report.xlsx", "excel"],
    ["OLD.XLS", "excel"],
    ["letter.docx", "word"],
    ["OLD.DOC", "word"],
  ])("opens %s with its official office app from the first release", (name, slug) => {
    const appId = `dev.everyos.${slug}`;
    expect(fileAppFor(name)).toBe(appId);
    mocks.active.mockReturnValue({ appId, version: "1.0.0", registry: { kind: "official" } });
    expect(openFileWithApp({ root: "home", path: name }, appId)).toBe(true);
    expect(mocks.open).toHaveBeenLastCalledWith(`everyos.desktop.${appId}`);
    expect(mocks.queue).toHaveBeenCalled();
  });
  it.each(["word", "excel"])(
    "offers the official %s installation when missing without exposing its file",
    (slug) => {
      mocks.active.mockReturnValue(undefined);
      const appId = `dev.everyos.${slug}`;
      expect(openFileWithApp({ root: "home", path: "private.docx" }, appId)).toBe(true);
      expect(mocks.open).toHaveBeenLastCalledWith("everyos.store", {
        appState: {
          tab: "browse",
          desktopAppRequest: { appId, registryId: "official", requestId: expect.any(String) },
        },
      });
      expect(mocks.queue).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.open.mock.calls)).not.toContain("private.docx");
    },
  );
  it("offers an update for installed versions that cannot receive files", () => {
    for (const version of ["1.0.0", "1.0.1-beta.1"]) {
      mocks.active.mockReturnValue({
        appId: "dev.everyos.pdf",
        version,
        registry: { kind: "official" },
      });
      expect(openFileWithApp({ root: "home", path: "document.pdf" }, "dev.everyos.pdf")).toBe(true);
      expect(mocks.open).toHaveBeenLastCalledWith("everyos.store", {
        appState: {
          tab: "browse",
          desktopAppRequest: {
            appId: "dev.everyos.pdf",
            registryId: "official",
            requestId: expect.any(String),
          },
        },
      });
    }
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
  });
  it("routes supported formats and special source names to their official apps", () => {
    for (const [name, slug] of [
      ["Document.PDF", "pdf"],
      [".hidden.mp4", "video"],
      ["photo.svg", "images"],
      ["README.md", "markdown"],
      ["data.geojson", "json"],
      ["events.ics", "calendar"],
      ["drawing.excalidraw", "whiteboard"],
      ["notes.txt", "text"],
      ["table.tsv", "text"],
      ["table.CSV", "excel"],
      ["config.yaml", "code"],
      ["settings.jsonc", "code"],
      ["script.ts", "code"],
      ["Dockerfile", "code"],
      [".gitignore", "code"],
    ])
      expect(fileAppFor(name!)).toBe(`dev.everyos.${slug}`);
    for (const name of ["archive.zip", "song.mp3", "movie.mp4.exe", "unknown"])
      expect(fileAppFor(name)).toBeNull();
  });
  it("requests the specific official viewer installation without giving the store file access", () => {
    mocks.active.mockReturnValue(undefined);
    expect(openFileWithApp({ root: "home", path: "private.pdf" }, "dev.everyos.pdf")).toBe(true);
    expect(mocks.open).toHaveBeenCalledWith("everyos.store", {
      appState: {
        tab: "browse",
        desktopAppRequest: {
          appId: "dev.everyos.pdf",
          registryId: "official",
          requestId: expect.any(String),
        },
      },
    });
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.open.mock.calls)).not.toContain("private.pdf");
  });
  it("opens only the active official player and queues consent before publishing its request", () => {
    const location = { root: "home", path: "Videos/clip.mp4" };
    expect(openFileWithApp(location, "dev.everyos.video")).toBe(true);
    expect(mocks.open).toHaveBeenCalledWith("everyos.desktop.dev.everyos.video");
    expect(mocks.queue).toHaveBeenCalledWith(
      "player-window",
      "dev.everyos.video",
      expect.any(String),
      location,
    );
    expect(mocks.setState).toHaveBeenCalledWith("player-window", {
      type: "everyos.file-open",
      requestId: expect.any(String),
    });
    expect(mocks.queue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setState.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(mocks.setState.mock.calls)).not.toContain("Videos/");
  });
  it("opens the official installation details for absent or non-official players without sharing the file", () => {
    mocks.active.mockReturnValue(undefined);
    expect(openFileWithApp({ root: "home", path: "a.mp4" }, "dev.everyos.video")).toBe(true);
    expect(mocks.open).toHaveBeenLastCalledWith("everyos.store", {
      appState: {
        tab: "browse",
        desktopAppRequest: {
          appId: "dev.everyos.video",
          registryId: "official",
          requestId: expect.any(String),
        },
      },
    });
    mocks.active.mockReturnValue({ appId: "dev.everyos.video", registry: { kind: "private" } });
    expect(openFileWithApp({ root: "home", path: "a.mp4" }, "dev.everyos.video")).toBe(true);
    expect(mocks.open.mock.calls.every(([id]) => id === "everyos.store")).toBe(true);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.open.mock.calls)).not.toContain("a.mp4");
  });
  it("refuses inaccessible player and store windows without queuing file access", () => {
    mocks.active.mockReturnValue({ appId: "dev.everyos.video", registry: { kind: "official" } });
    mocks.open.mockReturnValue(null);
    expect(openFileWithApp({ root: "home", path: "a.mp4" }, "dev.everyos.video")).toBe(false);
    mocks.active.mockReturnValue(undefined);
    expect(openFileWithApp({ root: "home", path: "a.mp4" }, "dev.everyos.video")).toBe(false);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("recognizes video suffixes without claiming unrelated or double-extension files", () => {
    expect(isVideoFile("Movie.MP4")).toBe(true);
    expect(isVideoFile(".hidden.mp4")).toBe(true);
    expect(isVideoFile("movie.webm")).toBe(true);
    expect(isVideoFile("movie.mp4.exe")).toBe(false);
    expect(isVideoFile("song.mp3")).toBe(false);
    expect(isVideoFile("audio.ogg")).toBe(false);
  });
});
