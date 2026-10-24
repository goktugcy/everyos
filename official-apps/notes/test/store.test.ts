import { createApp } from "@everyos/app-sdk";
import { mountMockHost } from "@everyos/app-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_REVISIONS,
  NotesStore,
  REVISION_GAP_MS,
  TRASH_MS,
  normalizeTags,
} from "../src/store.ts";

let unmount = () => undefined as void;
afterEach(() => unmount());

async function open(storage: Record<string, unknown> = {}) {
  const host = mountMockHost({ granted: ["storage:app"], storage });
  unmount = () => host.unmount();
  const app = await createApp();
  let now = Date.UTC(2026, 9, 1);
  const store = new NotesStore(app, () => now);
  return { host, store, tick: (ms: number) => (now += ms) };
}

describe("the notes store", () => {
  it("keeps notes with their titles, excerpts and text", async () => {
    const { store } = await open();
    const note = await store.create({
      text: "# Groceries\n\n- milk\n- bread",
      tags: ["Home", "home", " to do "],
    });
    expect(note).toMatchObject({
      title: "Groceries",
      excerpt: "milk bread",
      tags: ["home", "to-do"],
    });
    expect(await store.read(note.id)).toBe("# Groceries\n\n- milk\n- bread");
    const saved = await store.save(note.id, "# Shopping\nmilk");
    expect(saved).toMatchObject({ title: "Shopping", excerpt: "milk" });
    expect(await store.save(note.id, "# Shopping\nmilk")).toBeNull();
    expect((await store.list()).map((entry) => entry.title)).toEqual(["Shopping"]);
  });

  it("keeps earlier versions every few minutes, at most 20", async () => {
    const { store, tick } = await open();
    const note = await store.create({ text: "v0" });
    await store.save(note.id, "v1");
    tick(1000);
    await store.save(note.id, "v2"); // within the gap: no new version
    expect((await store.revisions(note.id)).map((entry) => entry.text)).toEqual(["v0"]);
    for (let version = 3; version < 30; version += 1) {
      tick(REVISION_GAP_MS);
      await store.save(note.id, `v${version}`);
    }
    const versions = await store.revisions(note.id);
    expect(versions).toHaveLength(MAX_REVISIONS);
    expect(versions[0]!.text).toBe("v28");
    const restored = await store.restoreRevision(note.id, versions[3]!.at);
    expect(restored).toBe(versions[3]!.text);
    expect(await store.read(note.id)).toBe(versions[3]!.text);
    expect((await store.revisions(note.id))[0]!.text).toBe("v29");
  });

  it("keeps deleted notes for 30 days, then removes them with their text", async () => {
    const { store, tick, host } = await open();
    const note = await store.create({ text: "old", pinned: true });
    await store.remove(note.id);
    expect((await store.list())[0]).toMatchObject({ pinned: false, deletedAt: expect.any(Number) });
    await store.restore(note.id);
    expect((await store.list())[0]!.deletedAt).toBeNull();
    await store.remove(note.id);
    tick(TRASH_MS + 1);
    expect(await store.list()).toEqual([]);
    expect([...host.storage.keys()].filter((key) => key.includes(note.id))).toEqual([]);
  });

  it("renames and deletes folders without losing notes", async () => {
    const { store } = await open();
    await store.setFolders(["Work", "Home", "Work", " "]);
    expect(await store.folders()).toEqual(["Work", "Home"]);
    const note = await store.create({ text: "plan", folder: "Work" });
    expect(await store.renameFolder("Work", "Home")).toBe(false);
    expect(await store.renameFolder("Work", "Office")).toBe(true);
    expect((await store.list()).find((entry) => entry.id === note.id)?.folder).toBe("Office");
    await store.deleteFolder("Office");
    expect(await store.folders()).toEqual(["Home"]);
    expect((await store.list())[0]!.folder).toBeNull();
  });

  it("exports a backup and imports it (once) elsewhere", async () => {
    const first = await open();
    await first.store.setFolders(["Ideas"]);
    await first.store.create({ text: "# A\nalpha", folder: "Ideas", tags: ["x"] });
    const gone = await first.store.create({ text: "# B" });
    await first.store.remove(gone.id);
    const backup = await first.store.exportAll();
    expect(backup.notes.map((note) => note.text)).toEqual(["# A\nalpha"]);
    unmount();

    const second = await open();
    expect(await second.store.importBackup(JSON.parse(JSON.stringify(backup)))).toBe(1);
    expect(await second.store.importBackup(backup)).toBe(0);
    expect(await second.store.folders()).toEqual(["Ideas"]);
    const [note] = await second.store.list();
    expect(note).toMatchObject({ title: "A", folder: "Ideas", tags: ["x"] });
    await expect(second.store.importBackup({ format: "other" })).rejects.toThrow(SyntaxError);
    // Entries that are not notes are skipped.
    expect(
      await second.store.importBackup({
        format: "everyos-notes/1",
        notes: [{ id: "../x", text: 1 }],
      }),
    ).toBe(0);
  });

  it("imports Markdown files as notes and spreads notes over index shards", async () => {
    const { store, host } = await open();
    expect(
      await store.importFiles(
        [
          { name: "empty.md", text: "" },
          { name: "b.txt", text: "Bee" },
        ],
        "Inbox",
      ),
    ).toBe(2);
    expect((await store.list()).map((note) => note.title).sort()).toEqual(["Bee", "empty"]);
    for (let index = 0; index < 40; index += 1) await store.create({ text: `n${index}` });
    expect((await store.list()).length).toBe(42);
    expect(
      [...host.storage.keys()].filter((key) => key.startsWith("index/")).length,
    ).toBeGreaterThan(1);
  });

  it("normalizes tags", () => {
    expect(normalizeTags("Work, #urgent,, big  idea\nwork")).toEqual([
      "work",
      "urgent",
      "big-idea",
    ]);
  });
});

describe("word counts", () => {
  it("count words, not Markdown marks, in every language", async () => {
    const { countWords } = await import("../src/editor.tsx");
    expect(countWords("# Title\n\n- [ ] one, two-three", "en")).toBe(4);
    expect(countWords("", "en")).toBe(0);
    expect(countWords("今日は良い天気です", "ja")).toBeGreaterThan(1);
  });
});
