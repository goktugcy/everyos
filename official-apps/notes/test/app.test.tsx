import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, pressKey, typeInto } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesApp } from "../src/notes-app.tsx";
import { QuickNote } from "../src/quick-note.tsx";

const publicDir = join(import.meta.dirname, "../public");
const GRANTED = ["storage:app", "files:pick", "files:save", "clipboard:write", "widgets:register"];
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(options: MockHostOptions = {}, Root = NotesApp) {
  rendered = await renderApp(Root, {
    publicDir,
    app: { id: "dev.everyos.notes", version: "1.0.0", name: "Notes" },
    granted: GRANTED,
    ...options,
  });
  return rendered;
}

const click = (element: Element | null) => {
  if (!(element instanceof HTMLElement)) throw new Error("Nothing to click");
  element.click();
};
const editor = () => document.querySelector<HTMLTextAreaElement>(".notes-textarea");
const rows = () => [...document.querySelectorAll(".notes-row-title")].map((row) => row.textContent);
const notesIn = (host: RenderedApp["host"]) =>
  [...host.storage.entries()]
    .filter(([key]) => key.startsWith("index/"))
    .flatMap(
      ([, value]) => value as Array<{ id: string; title: string; deletedAt: number | null }>,
    );

describe("Notes", () => {
  it("starts empty in the person's language, then writes and saves a note", async () => {
    const { host } = await start({ locale: "tr" });
    await vi.waitFor(() => expect(byText("Henüz not yok")).not.toBeNull());
    expect(host.ready).toBe(true);
    click(byRole("button", "Yeni not"));
    await vi.waitFor(() => expect(editor()?.disabled).toBe(false));
    typeInto(editor(), "# Alışveriş\n\n- süt\n- [ ] ekmek");
    await vi.waitFor(() => expect(notesIn(host)[0]?.title).toBe("Alışveriş"), { timeout: 3000 });
    expect(host.storage.get(`body/${notesIn(host)[0]!.id}`)).toBe(
      "# Alışveriş\n\n- süt\n- [ ] ekmek",
    );
    // The preview renders Markdown (task lists too); the window is titled after the note.
    await vi.waitFor(() =>
      expect(document.querySelector(".notes-preview h1")?.textContent).toBe("Alışveriş"),
    );
    expect(
      document.querySelector<HTMLInputElement>(".notes-preview input[type=checkbox]")?.disabled,
    ).toBe(true);
    await vi.waitFor(() => expect(host.window.title).toBe("Alışveriş"));
    expect(byText("3 kelime")).not.toBeNull();
    expect(host.window.state).toEqual({ noteId: notesIn(host)[0]!.id });
  });

  it("never renders HTML from a note", async () => {
    await start({
      storage: {
        "index/0": [
          {
            id: "abcd1234",
            title: "x",
            excerpt: "",
            folder: null,
            tags: [],
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          },
        ],
        "body/abcd1234":
          '<img src=x onerror="alert(1)"><script>alert(2)</script>[x](javascript:alert(3))',
      },
    });
    await vi.waitFor(() => expect(rows()).toEqual(["x"]));
    click(document.querySelector(".notes-row"));
    await vi.waitFor(() =>
      expect(document.querySelector(".notes-preview")?.textContent).toContain("<img"),
    );
    const preview = document.querySelector(".notes-preview")!;
    expect(preview.querySelector("img, script, [onerror]")).toBeNull();
    expect(preview.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("finds notes by their text, tags and title, and sorts pinned notes first", async () => {
    const { app } = await start();
    const { NotesStore } = await import("../src/store.ts");
    const store = new NotesStore(app);
    await store.create({ text: "# Trip\nPack the passport", tags: ["travel"] });
    await store.create({ text: "# Recipes\nLentil soup", pinned: true });
    await store.create({ text: "# Budget\nRent and bills" });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(rows()).toEqual(["Recipes", "Budget", "Trip"]));
    typeInto(document.querySelector("input[type=search]"), "passport");
    await vi.waitFor(() => expect(rows()).toEqual(["Trip"]));
    typeInto(document.querySelector("input[type=search]"), "#travel");
    await vi.waitFor(() => expect(rows()).toEqual(["Trip"]));
    typeInto(document.querySelector("input[type=search]"), "nothing like this");
    await vi.waitFor(() => expect(byText("No notes match “nothing like this”")).not.toBeNull());
    typeInto(document.querySelector("input[type=search]"), "");
    const sort = byRole("combobox", "Sort by") as HTMLSelectElement;
    sort.value = "title";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(rows()).toEqual(["Recipes", "Budget", "Trip"]));
  });

  it("moves notes to Recently deleted, restores them and deletes them for good", async () => {
    const { app, host } = await start();
    const { NotesStore } = await import("../src/store.ts");
    await new NotesStore(app).create({ text: "# Old idea" });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(rows()).toEqual(["Old idea"]));
    click(document.querySelector(".notes-row"));
    await vi.waitFor(() => expect(byRole("button", "Delete note")).not.toBeNull());
    click(byRole("button", "Delete note"));
    await vi.waitFor(() => expect(byText("Moved to Recently deleted")).not.toBeNull());
    expect(rows()).toEqual([]);
    click(byText("Recently deleted", "button"));
    await vi.waitFor(() => expect(rows()).toEqual(["Old idea"]));
    click(document.querySelector(".notes-row"));
    await vi.waitFor(() => expect(byRole("button", "Restore")).not.toBeNull());
    click(byRole("button", "Restore"));
    await vi.waitFor(() => expect(rows()).toEqual([]));
    expect(notesIn(host)[0]!.deletedAt).toBeNull();

    click(byText("All notes", "button"));
    await vi.waitFor(() => expect(rows()).toEqual(["Old idea"]));
    click(document.querySelector(".notes-row"));
    await vi.waitFor(() => expect(byRole("button", "Delete note")).not.toBeNull());
    click(byRole("button", "Delete note"));
    click(byText("Recently deleted", "button"));
    await vi.waitFor(() => expect(byRole("button", "Empty")).not.toBeNull());
    click(byRole("button", "Empty"));
    await vi.waitFor(() => expect(notesIn(host)).toEqual([]));
    expect(host.calls.find((call) => call.method === "dialog.confirm")?.params).toMatchObject({
      destructive: true,
    });
  });

  it("imports Markdown files and backups, and exports everything", async () => {
    const backup = {
      format: "everyos-notes/1",
      exportedAt: 1,
      folders: ["Work"],
      notes: [
        {
          id: "work0001",
          title: "",
          excerpt: "",
          folder: "Work",
          tags: ["q3"],
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          text: "# Q3 plan",
        },
      ],
    };
    const { host } = await start({
      files: {
        "/import/today.md": "# Today\nWrite tests",
        "/import/backup.json": JSON.stringify(backup),
      },
    });
    await vi.waitFor(() => expect(byRole("button", "Import notes…")).not.toBeNull());
    click(byRole("button", "Import notes…"));
    await vi.waitFor(() => expect(byText("2 notes imported")).not.toBeNull());
    expect(rows().sort()).toEqual(["Q3 plan", "Today"]);
    await vi.waitFor(() => expect(byText("Work", "button")).not.toBeNull());
    click(byText("q3", "button"));
    await vi.waitFor(() => expect(rows()).toEqual(["Q3 plan"]));

    click(byRole("button", "Export all notes…"));
    await vi.waitFor(() =>
      expect(host.readText(`/notes-${new Date().toISOString().slice(0, 10)}.json`)).toContain(
        "Q3 plan",
      ),
    );
    const exported = JSON.parse(
      host.readText(`/notes-${new Date().toISOString().slice(0, 10)}.json`)!,
    );
    expect(exported.notes).toHaveLength(2);
  });

  it("organizes notes in folders and with tags", async () => {
    const { app, host } = await start();
    const { NotesStore } = await import("../src/store.ts");
    await new NotesStore(app).create({ text: "# Report" });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(rows()).toEqual(["Report"]));
    click(byRole("button", "New folder"));
    await vi.waitFor(() => expect(byRole("textbox", "Folder name")).not.toBeNull());
    typeInto(byRole("textbox", "Folder name"), "Work");
    click(byRole("button", "New"));
    await vi.waitFor(() => expect(host.storage.get("folders")).toEqual(["Work"]));
    click(byText("All notes", "button"));
    await vi.waitFor(() => expect(rows()).toEqual(["Report"]));
    click(document.querySelector(".notes-row"));
    await vi.waitFor(() => expect(byRole("combobox", "Folder")).not.toBeNull());
    const folder = byRole("combobox", "Folder") as HTMLSelectElement;
    folder.value = "Work";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
    const tags = byRole("textbox", "Tags") as HTMLInputElement;
    typeInto(tags, "Quarterly, finance");
    tags.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await vi.waitFor(() =>
      expect(notesIn(host)[0]).toMatchObject({ folder: "Work", tags: ["quarterly", "finance"] }),
    );
    click(byText("finance", "button"));
    await vi.waitFor(() => expect(rows()).toEqual(["Report"]));
  });

  it("copies a note, pins it from the keyboard and opens notes a widget asks for", async () => {
    const { app, host } = await start();
    const { NotesStore } = await import("../src/store.ts");
    const store = new NotesStore(app);
    await store.create({ text: "# First" });
    const second = await store.create({ text: "# Second\nbody" });
    host.emit("window.opened", { state: { noteId: second.id } });
    await vi.waitFor(() => expect(editor()?.value).toBe("# Second\nbody"));
    click(byRole("button", "Copy Markdown"));
    await vi.waitFor(() => expect(host.clipboard).toEqual(["# Second\nbody"]));
    pressKey("p", { mod: true, shift: true }, window);
    await vi.waitFor(() =>
      expect(notesIn(host).find((note) => note.id === second.id)).toMatchObject({ pinned: true }),
    );
  });

  it("restores an earlier version", async () => {
    const { app } = await start();
    const { NotesStore } = await import("../src/store.ts");
    const store = new NotesStore(app, () => Date.now() - 10 * 60_000);
    const note = await store.create({ text: "# Draft one" });
    await store.save(note.id, "# Draft two");
    openNote(note.id);
    await vi.waitFor(() => expect(editor()?.value).toBe("# Draft two"));
    click(byRole("button", "Version history"));
    await vi.waitFor(() =>
      expect(document.querySelector(".notes-history-preview h1")?.textContent).toBe("Draft one"),
    );
    click(byRole("button", "Restore this version"));
    await vi.waitFor(() => expect(editor()?.value).toBe("# Draft one"));
    expect(byText("Earlier version restored")).not.toBeNull();
  });

  it("explains a missing permission instead of failing silently", async () => {
    const { app } = await start({ granted: ["storage:app"] });
    const { NotesStore } = await import("../src/store.ts");
    const note = await new NotesStore(app).create({ text: "# Secret" });
    openNote(note.id);
    await vi.waitFor(() => expect(byRole("button", "Copy Markdown")).not.toBeNull());
    click(byRole("button", "Copy Markdown"));
    await vi.waitFor(() =>
      expect(byText("This app was not allowed to clipboard:write.")).not.toBeNull(),
    );
  });
});

function openNote(noteId: string) {
  rendered!.host.emit("window.opened", { state: { noteId } });
}

describe("the quick-note widget", () => {
  it("adds a note and opens the app at a recent note", async () => {
    const { host } = await start(
      { kind: "widget", widgetId: "quick", granted: ["storage:app"], locale: "de" },
      QuickNote,
    );
    await vi.waitFor(() => expect(byText("Noch keine Notizen")).not.toBeNull());
    typeInto(byRole("textbox", "Schnelle Notiz schreiben…"), "Call the plumber");
    click(byRole("button", "Notiz hinzufügen"));
    await vi.waitFor(() => expect(byText("Notiz hinzugefügt")).not.toBeNull());
    expect(notesIn(host)[0]?.title).toBe("Call the plumber");
    await vi.waitFor(() => expect(byRole("button", "Call the plumber")).not.toBeNull());
    click(byRole("button", "Call the plumber"));
    await vi.waitFor(() =>
      expect(host.calls.find((call) => call.method === "window.open")?.params).toEqual({
        state: { noteId: notesIn(host)[0]!.id },
      }),
    );
  });
});
