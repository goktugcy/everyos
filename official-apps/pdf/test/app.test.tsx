import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, pressKey, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfApp } from "../src/pdf-app.tsx";
import type {
  FindQuery,
  OpenOptions,
  PdfEngine,
  PdfSession,
  SessionEvent,
  ZoomValue,
} from "../src/types.ts";
import { makePdf } from "./make-pdf.ts";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const settle = () => new Promise((resolve) => setTimeout(resolve));

// The test DOM has no layout, so nothing ever scrolls into view: say every element is in view.
globalThis.IntersectionObserver = class {
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element) {
    this.#callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;

/** pdf.js stand-in: the app's side of the conversation, recorded. */
class FakeSession implements PdfSession {
  readonly pageCount = 4;
  readonly fingerprint = "f00dcafe";
  readonly title = "Field guide";
  readonly outline = [
    {
      title: "Intro",
      dest: "intro",
      url: null,
      bold: true,
      italic: false,
      items: [
        { title: "Part two", dest: "part-two", url: null, bold: false, italic: false, items: [] },
      ],
    },
  ];
  page = 1;
  scale = 1;
  rotation = 0;
  readonly calls: Array<[string, ...unknown[]]> = [];
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  destroyed = false;
  #emit(event: SessionEvent) {
    for (const listener of this.#listeners) listener(event);
  }
  goTo(page: number) {
    this.calls.push(["goTo", page]);
    this.page = page;
    this.#emit({ kind: "page", page });
  }
  goToDestination(dest: unknown) {
    this.calls.push(["goToDestination", dest]);
    this.goTo(dest === "part-two" ? 3 : 1);
    return Promise.resolve();
  }
  setZoom(value: ZoomValue) {
    this.calls.push(["setZoom", value]);
    this.scale =
      value === "in"
        ? this.scale * 1.1
        : value === "out"
          ? this.scale / 1.1
          : typeof value === "number"
            ? value
            : 1;
    this.#emit({ kind: "scale", scale: this.scale });
  }
  setRotation(rotation: number) {
    this.calls.push(["setRotation", rotation]);
    this.rotation = rotation;
    this.#emit({ kind: "rotation", rotation });
  }
  find(query: FindQuery, again?: "next" | "previous") {
    this.calls.push(["find", query.text, again ?? null, query.caseSensitive]);
    const found = query.text === "needle";
    this.#emit({
      kind: "find",
      state: found ? "found" : "notFound",
      current: found ? 2 : 0,
      total: found ? 5 : 0,
    });
  }
  clearFind() {
    this.calls.push(["clearFind"]);
  }
  renderThumbnail(page: number) {
    this.calls.push(["thumbnail", page]);
    return Promise.resolve();
  }
  renderForPrint(page: number, dpi: number) {
    this.calls.push(["print", page, dpi]);
    return Promise.resolve(new Blob([`page ${page}`], { type: "image/png" }));
  }
  formChanges = false;
  hasFormChanges() {
    return this.formChanges;
  }
  saveWithChanges() {
    return Promise.resolve(new TextEncoder().encode("%PDF-filled"));
  }
  on(listener: (event: SessionEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  destroy() {
    this.destroyed = true;
  }
}

function fakeEngine(
  behaviour: (options: OpenOptions, data: Uint8Array) => Promise<void> = () => Promise.resolve(),
) {
  const sessions: FakeSession[] = [];
  const engine: PdfEngine = {
    async open(data, container, options) {
      expect(container.querySelector(".pdfViewer")).not.toBeNull();
      await behaviour(options, data);
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  };
  return { engine, sessions };
}

const BYTES = makePdf({ pages: [["One"], ["Two"], ["Three"], ["Four"]] });

async function start(options: MockHostOptions & { engine?: PdfEngine } = {}) {
  const { engine = fakeEngine().engine, ...host } = options;
  rendered = await renderApp(() => <PdfApp loadEngine={() => Promise.resolve(engine)} />, {
    publicDir,
    app: { id: "dev.everyos.pdf", version: "1.0.0", name: "PDF Viewer" },
    granted: ["storage:app", "files:pick", "files:save"],
    files: { "/docs/guide.pdf": BYTES },
    ...host,
  });
  await vi.waitFor(() => expect(document.querySelector(".pdf-app")).not.toBeNull());
  await settle();
  return rendered;
}

async function click(role: string, name: string | RegExp) {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  await settle();
  byRole(role, name)!.click();
}
const pageInput = () => byRole("textbox", "Page number") as HTMLInputElement;

async function openGuide() {
  await click("button", "Open PDF…");
  await vi.waitFor(() =>
    expect(document.querySelector(".pdf-page-count")?.textContent).toBe("of 4"),
  );
}

describe("PDF Viewer", () => {
  it("opens where the person left the document, with their bookmarks", async () => {
    const fake = fakeEngine();
    const { host } = await start({
      engine: fake.engine,
      storage: {
        "doc/f00dcafe": {
          page: 3,
          zoom: "page-width",
          rotation: 90,
          bookmarks: [{ page: 2, label: "Methods", createdAt: 1 }],
        },
      },
    });
    await openGuide();
    const session = fake.sessions[0]!;
    expect(session.calls.slice(0, 3)).toEqual([
      ["setRotation", 90],
      ["setZoom", "page-width"],
      ["goTo", 3],
    ]);
    expect(pageInput().value).toBe("3");
    expect(byText("Field guide", ".eui-toolbar-title, h1, *")).not.toBeNull();
    expect(host.window.title).toBe("Field guide");
    expect((byRole("combobox", "Zoom") as HTMLSelectElement).value).toBe("page-width");
    await click("tab", "Bookmarks");
    await vi.waitFor(() => expect(byText("Methods")).not.toBeNull());
    await vi.waitFor(() =>
      expect(host.storage.get("recent")).toMatchObject([
        { name: "guide.pdf", fingerprint: "f00dcafe" },
      ]),
    );
  });

  it("moves between pages, zooms and rotates", async () => {
    const fake = fakeEngine();
    await start({ engine: fake.engine });
    await openGuide();
    const session = fake.sessions[0]!;
    await click("button", "Next page");
    await vi.waitFor(() => expect(pageInput().value).toBe("2"));
    expect(byRole("button", "Previous page")!.hasAttribute("disabled")).toBe(false);
    typeInto(pageInput(), "4");
    pressKey("Enter", {}, pageInput());
    await vi.waitFor(() => expect(session.page).toBe(4));
    expect(byRole("button", "Next page")!.hasAttribute("disabled")).toBe(true);
    typeInto(pageInput(), "9");
    pressKey("Enter", {}, pageInput());
    await vi.waitFor(() => expect(pageInput().value).toBe("4"));

    await click("button", /^Zoom in/);
    await vi.waitFor(() =>
      expect((byRole("combobox", "Zoom") as HTMLSelectElement).value).toBe(String(1.1)),
    );
    expect(byText("110 %", "option")).not.toBeNull();
    const zoom = byRole("combobox", "Zoom") as HTMLSelectElement;
    zoom.value = "page-fit";
    zoom.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(session.calls).toContainEqual(["setZoom", "page-fit"]));

    await click("button", "Rotate right");
    await vi.waitFor(() => expect(session.rotation).toBe(90));
    await click("button", "Rotate left");
    await click("button", "Rotate left");
    await vi.waitFor(() => expect(session.rotation).toBe(270));
  });

  it("searches the text and moves between matches", async () => {
    const fake = fakeEngine();
    await start({ engine: fake.engine });
    await openGuide();
    const session = fake.sessions[0]!;
    pressKey("f", { mod: true }, window);
    await vi.waitFor(() => expect(byRole("textbox", "Find")).not.toBeNull());
    typeInto(byRole("textbox", "Find"), "needle");
    await vi.waitFor(() =>
      expect(byRole("status", /of 5 matches/)?.textContent).toBe("2 of 5 matches"),
    );
    expect(session.calls).toContainEqual(["find", "needle", null, false]);
    pressKey("Enter", {}, byRole("textbox", "Find")!);
    pressKey("Enter", { shift: true }, byRole("textbox", "Find")!);
    expect(session.calls).toContainEqual(["find", "needle", "next", false]);
    expect(session.calls).toContainEqual(["find", "needle", "previous", false]);
    byRole("checkbox", "Match case")!.click();
    await vi.waitFor(() => expect(session.calls).toContainEqual(["find", "needle", null, true]));
    typeInto(byRole("textbox", "Find"), "nothing here");
    await vi.waitFor(() =>
      expect(document.querySelector(".pdf-find-status")?.textContent).toBe("Not found"),
    );
    pressKey("Escape", {}, byRole("textbox", "Find")!);
    await vi.waitFor(() => expect(byRole("textbox", "Find")).toBeNull());
    expect(session.calls.at(-1)).toEqual(["clearFind"]);
  });

  it("follows the outline and keeps bookmarks", async () => {
    const fake = fakeEngine();
    const { host } = await start({ engine: fake.engine, prompt: () => "Summary" });
    await openGuide();
    const session = fake.sessions[0]!;
    await vi.waitFor(() =>
      expect(session.calls.filter(([name]) => name === "thumbnail").length).toBe(4),
    );
    await click("tab", "Outline");
    await click("button", "Expand Intro");
    await click("button", "Part two");
    await vi.waitFor(() => expect(pageInput().value).toBe("3"));
    expect(session.calls).toContainEqual(["goToDestination", "part-two"]);

    await click("button", "Bookmark this page");
    await click("tab", "Bookmarks");
    await vi.waitFor(() => expect(byText("Page 3", ".pdf-bookmark-label")).not.toBeNull());
    await click("button", "Rename “Page 3”");
    await vi.waitFor(() => expect(byText("Summary", ".pdf-bookmark-label")).not.toBeNull());
    expect(byRole("button", "Remove this page's bookmark")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(host.storage.get("doc/f00dcafe")).toMatchObject({
        page: 3,
        bookmarks: [{ page: 3, label: "Summary" }],
      }),
    );
    await click("button", "Remove “Summary”");
    await vi.waitFor(() => expect(byText("No bookmarks yet")).not.toBeNull());
  });

  it("prints every page and saves a copy", async () => {
    const fake = fakeEngine();
    const { host } = await start({ engine: fake.engine, saveAs: () => "/copies/guide.pdf" });
    await openGuide();
    const session = fake.sessions[0]!;
    let printed = -1;
    window.print = () => {
      printed = document.querySelectorAll(".pdf-print img").length;
    };
    await click("button", /^Print/);
    await vi.waitFor(() => expect(printed).toBe(4));
    expect(session.calls.filter(([name]) => name === "print")).toEqual([
      ["print", 1, 150],
      ["print", 2, 150],
      ["print", 3, 150],
      ["print", 4, 150],
    ]);
    window.dispatchEvent(new Event("afterprint"));
    expect(document.querySelectorAll(".pdf-print img")).toHaveLength(0);

    await click("button", /^Save a copy/);
    await vi.waitFor(() => expect(host.files.get("/copies/guide.pdf")?.data).toEqual(BYTES));
    session.formChanges = true;
    await click("button", /^Save a copy/);
    await vi.waitFor(() => expect(host.readText("/copies/guide.pdf")).toBe("%PDF-filled"));
  });

  it("asks for a password, and handles damaged files", async () => {
    let answer: string | null = null;
    const fake = fakeEngine(async (options) => {
      answer = await options.onPassword("need");
      if (answer === null)
        throw Object.assign(new Error("Loading aborted"), { name: "AbortException" });
      if (answer !== "secret") {
        answer = await options.onPassword("incorrect");
        if (answer !== "secret")
          throw Object.assign(new Error("bad"), { name: "PasswordException" });
      }
    });
    await start({ engine: fake.engine });
    await click("button", "Open PDF…");
    await vi.waitFor(() => expect(byText("This PDF is protected")).not.toBeNull());
    typeInto(
      byRole("textbox", "Password") ??
        document.querySelector<HTMLInputElement>("input[type=password]")!,
      "wrong",
    );
    await click("button", "Open");
    await vi.waitFor(() => expect(byText("That password is not right. Try again.")).not.toBeNull());
    typeInto(document.querySelector<HTMLInputElement>("input[type=password]"), "secret");
    await click("button", "Open");
    await vi.waitFor(() =>
      expect(document.querySelector(".pdf-page-count")?.textContent).toBe("of 4"),
    );
    rendered!.unmount();
    rendered = null;

    const broken = fakeEngine(() =>
      Promise.reject(Object.assign(new Error("Invalid"), { name: "InvalidPDFException" })),
    );
    await start({ engine: broken.engine, locale: "tr" });
    await click("button", "PDF aç…");
    await vi.waitFor(() => expect(byText("“guide.pdf” bir PDF değil ya da bozuk.")).not.toBeNull());
  });

  it("reopens recent documents and forgets those no longer reachable", async () => {
    const first = await start();
    await openGuide();
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    const storage = Object.fromEntries(first.host.storage);
    const handles = first.host.persistentHandles();
    rendered!.unmount();
    rendered = null;

    await start({ storage, handles });
    await click("button", /guide\.pdf/);
    await vi.waitFor(() =>
      expect(document.querySelector(".pdf-page-count")?.textContent).toBe("of 4"),
    );
    rendered!.unmount();
    rendered = null;

    const { host } = await start({ storage });
    await click("button", /guide\.pdf/);
    await vi.waitFor(() => expect(byText("“guide.pdf” is no longer available.")).not.toBeNull());
    await vi.waitFor(() => expect(host.storage.get("recent")).toEqual([]));
  });
});
