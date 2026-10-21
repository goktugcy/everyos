import { DARK_THEME, type MockHostOptions } from "@everyos/app-testing";
import { byRole, byText } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasModule, CanvasProps } from "../src/canvas-types.ts";
import { WhiteboardApp } from "../src/whiteboard-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const settle = () => new Promise((resolve) => setTimeout(resolve));

/** Excalidraw stand-in: a list of shapes the test draws through `draw()`. */
function fakeCanvas() {
  const state = { shapes: [] as string[], props: null as CanvasProps | null, mounts: 0 };
  const scene = () => JSON.stringify({ type: "excalidraw", elements: state.shapes });
  function Canvas(props: CanvasProps) {
    useEffect(() => {
      state.mounts += 1;
      state.props = props;
      state.shapes = props.scene
        ? (JSON.parse(props.scene) as { elements: string[] }).elements
        : [];
      props.onReady({
        serialize: scene,
        version: () => String(state.shapes.length),
        isEmpty: () => state.shapes.length === 0,
        exportPng: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
        exportSvg: () => Promise.resolve(`<svg>${state.shapes.join(",")}</svg>`),
      });
    }, []);
    return (
      <div className="fake-canvas" aria-label={props.labels.canvas} data-theme={props.theme} />
    );
  }
  const module: CanvasModule = {
    Canvas,
    importScene: (bytes, name) => {
      const text = new TextDecoder().decode(bytes);
      if (!name.endsWith(".excalidraw")) return Promise.reject(new Error("not a board"));
      return Promise.resolve(text);
    },
  };
  const draw = (shape: string) => {
    state.shapes = [...state.shapes, shape];
    state.props!.onChange();
  };
  return { module, state, draw };
}

async function start(fake: ReturnType<typeof fakeCanvas>, options: MockHostOptions = {}) {
  rendered = await renderApp(
    () => <WhiteboardApp loadCanvas={() => Promise.resolve(fake.module)} />,
    {
      publicDir,
      app: { id: "dev.everyos.whiteboard", version: "1.0.0", name: "Whiteboard" },
      granted: ["storage:app", "files:pick", "files:save"],
      ...options,
    },
  );
  await vi.waitFor(() => expect(document.querySelector(".fake-canvas")).not.toBeNull());
  await settle();
  return rendered;
}

async function click(role: string, name: string | RegExp) {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  await settle();
  byRole(role, name)!.click();
}
const boardNames = () =>
  [...document.querySelectorAll(".wb-board-name")].map((entry) => entry.textContent);

describe("Whiteboard", () => {
  it("starts with a board, saves drawings a moment after the last change, and reopens them", async () => {
    const fake = fakeCanvas();
    const first = await start(fake);
    expect(boardNames()).toEqual(["My board"]);
    fake.draw("rectangle");
    fake.draw("arrow");
    await vi.waitFor(() => expect(byRole("status")?.textContent).toBe("Saved"));
    await vi.waitFor(() =>
      expect([...first.host.storage.keys()].some((key) => key.startsWith("board/"))).toBe(true),
    );
    const storage = Object.fromEntries(first.host.storage);
    rendered!.unmount();
    rendered = null;

    const again = fakeCanvas();
    await start(again, { storage });
    expect(again.state.shapes).toEqual(["rectangle", "arrow"]);
  });

  it("keeps a drawing made just before the window closes", async () => {
    const fake = fakeCanvas();
    const first = await start(fake);
    fake.draw("circle");
    // Closed before the save pause: stashed at once.
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(first.host.storage.has("stash")).toBe(true));
    const storage = Object.fromEntries(first.host.storage);
    rendered!.unmount();
    rendered = null;

    const again = fakeCanvas();
    const second = await start(again, { storage });
    expect(again.state.shapes).toEqual(["circle"]);
    await vi.waitFor(() => expect(second.host.storage.has("stash")).toBe(false));
  });

  it("makes, renames, duplicates and deletes boards", async () => {
    const fake = fakeCanvas();
    const names = ["Roadmap"];
    const { host } = await start(fake, { prompt: () => names.shift() ?? null });
    fake.draw("idea");
    await click("button", "New board");
    await vi.waitFor(() => expect(boardNames()).toEqual(["Board 2", "My board"]));
    expect(fake.state.shapes).toEqual([]);
    expect(byRole("button", /^Board 2/)?.getAttribute("aria-current")).toBe("page");
    // The first board's drawing was saved on the way.
    await click("button", /^My board/);
    await vi.waitFor(() => expect(fake.state.shapes).toEqual(["idea"]));
    await click("button", "Rename My board");
    await vi.waitFor(() => expect(boardNames()).toContain("Roadmap"));
    await click("button", "Duplicate Roadmap");
    await vi.waitFor(() => expect(boardNames()).toEqual(["Roadmap (copy)", "Board 2", "Roadmap"]));
    expect(fake.state.shapes).toEqual(["idea"]);
    await click("button", "Delete Roadmap (copy)");
    await vi.waitFor(() => expect(boardNames()).toEqual(["Board 2", "Roadmap"]));
    expect(host.window.title).toMatch(/— Whiteboard$/);
  });

  it("exports PNG, SVG and the board file, and imports boards", async () => {
    const fake = fakeCanvas();
    const { host } = await start(fake, {
      files: {
        "/boards/plan.excalidraw": JSON.stringify({ elements: ["imported"] }),
        "/notes.txt": "hello",
      },
      pick: (request) => (request.accept.includes(".excalidraw") ? [pickNext()] : null),
    });
    let picks = ["/notes.txt", "/boards/plan.excalidraw"];
    function pickNext() {
      const [next, ...rest] = picks;
      picks = rest;
      return next!;
    }
    await click("button", "PNG");
    await vi.waitFor(() =>
      expect(byText("There is nothing on this board to export yet.")).not.toBeNull(),
    );
    fake.draw("box");
    await click("button", "PNG");
    await vi.waitFor(() =>
      expect(host.files.get("/My board.png")?.data).toEqual(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      ),
    );
    await click("button", "SVG");
    await vi.waitFor(() => expect(host.readText("/My board.svg")).toBe("<svg>box</svg>"));
    await click("button", "Save as a board file (.excalidraw)…");
    await vi.waitFor(() => expect(host.readText("/My board.excalidraw")).toContain('"box"'));

    await click("button", "Import a board…");
    await vi.waitFor(() =>
      expect(byText("“notes.txt” is not a board file this app can read.")).not.toBeNull(),
    );
    await click("button", "Import a board…");
    await vi.waitFor(() => expect(boardNames()).toEqual(["plan", "My board"]));
    await vi.waitFor(() => expect(fake.state.shapes).toEqual(["imported"]));
  });

  it("follows the EveryOS theme", async () => {
    const fake = fakeCanvas();
    const { host } = await start(fake, { locale: "tr" });
    expect(document.querySelector(".fake-canvas")?.getAttribute("data-theme")).toBe("light");
    expect(byText("Tahtam", ".wb-board-name")).not.toBeNull();
    host.setTheme(DARK_THEME);
    await vi.waitFor(() =>
      expect(document.querySelector(".fake-canvas")?.getAttribute("data-theme")).toBe("dark"),
    );
  });
});
