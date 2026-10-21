import type { EveryOSApp } from "@everyos/app-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/doc-editor.tsx";
import {
  BinaryFileError,
  decodeFile,
  EncodingError,
  fromFile,
  isDirty,
  newDoc,
  Recovery,
  RECOVERY_LIMIT,
  sameSource,
  toDisk,
  type Decoded,
  type Source,
} from "../src/documents.ts";
import { baseName, joinPath, nameProblem, parentOf, sortEntries } from "../src/workspace.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("workspace paths and names", () => {
  it("sorts folders first, then names naturally", () => {
    const sorted = sortEntries([
      { name: "file10.ts", kind: "file" },
      { name: "README.md", kind: "file" },
      { name: "src", kind: "directory" },
      { name: "file2.ts", kind: "file" },
      { name: "assets", kind: "directory" },
    ] as const);
    expect(sorted.map((entry) => entry.name)).toEqual([
      "assets",
      "src",
      "file2.ts",
      "file10.ts",
      "README.md",
    ]);
  });

  it("joins and splits workspace paths", () => {
    expect(joinPath("", "a.ts")).toBe("a.ts");
    expect(joinPath("src/lib", "a.ts")).toBe("src/lib/a.ts");
    expect(parentOf("src/lib/a.ts")).toBe("src/lib");
    expect(parentOf("a.ts")).toBe("");
    expect(baseName("src/lib/a.ts")).toBe("a.ts");
  });

  it("explains names that cannot be used", () => {
    expect(nameProblem("index.ts", ["main.ts"])).toBeNull();
    expect(nameProblem("  ")).toBe("empty");
    expect(nameProblem("..")).toBe("reserved");
    expect(nameProblem("src/x.ts")).toBe("separator");
    expect(nameProblem("a\\b")).toBe("separator");
    expect(nameProblem("ç".repeat(128))).toBe("tooLong");
    expect(nameProblem("Main.TS", ["main.ts"])).toBe("exists");
  });
});

describe("reading and writing files", () => {
  it("keeps line endings and the byte order mark", () => {
    const crlf = decodeFile(bytes("one\r\ntwo\r\n"));
    expect(crlf).toEqual({ text: "one\ntwo\n", eol: "crlf", bom: false });
    expect(toDisk({ ...crlf, text: "one\ntwo\nthree\n" })).toBe("one\r\ntwo\r\nthree\r\n");
    const withBom = decodeFile(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("ğ\n")]));
    expect(withBom).toEqual({ text: "ğ\n", eol: "lf", bom: true });
    expect(toDisk(withBom)).toBe("﻿ğ\n");
    expect(decodeFile(bytes("old\rmac")).text).toBe("old\nmac");
  });

  it("refuses binary files and text that is not UTF-8", () => {
    expect(() => decodeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toThrow(
      BinaryFileError,
    );
    // "Karı" in Windows-1254: not valid UTF-8, and saving it from here would change it.
    expect(() => decodeFile(new Uint8Array([0x4b, 0x61, 0x72, 0xfd]))).toThrow(EncodingError);
  });

  it("knows when a tab has unsaved changes", () => {
    const doc = fromFile("a.ts", { kind: "file", handleId: "h1" }, decodeFile(bytes("x\r\n")));
    expect(isDirty(doc)).toBe(false);
    expect(isDirty({ ...doc, text: "y\n" })).toBe(true);
    expect(isDirty({ ...doc, eol: "lf" })).toBe(true);
  });

  it("compares where tabs come from", () => {
    const a: Source = { kind: "workspace", rootId: "h1", path: "src/a.ts" };
    expect(sameSource(a, { ...a })).toBe(true);
    expect(sameSource(a, { ...a, path: "src/b.ts" })).toBe(false);
    expect(sameSource(a, { kind: "file", handleId: "h1" })).toBe(false);
    expect(sameSource(null, null)).toBe(false);
  });

  it("checks stored settings", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(
      sanitizeSettings({
        theme: "neon",
        fontSize: 99,
        tabSize: 4,
        insertSpaces: "no",
        minimap: false,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, tabSize: 4, minimap: false });
  });
});

describe("recovery", () => {
  function fakeApp() {
    const storage = new Map<string, unknown>();
    const app = {
      storage: {
        get: (key: string) => Promise.resolve(storage.get(key)),
        set: (key: string, value: unknown) => Promise.resolve(void storage.set(key, value)),
        delete: (key: string) => Promise.resolve(void storage.delete(key)),
      },
    } as unknown as EveryOSApp;
    return { app, storage };
  }

  it("brings back unsaved text, rereads clean files and reports what is lost", async () => {
    const { app, storage } = fakeApp();
    const recovery = new Recovery(app);
    const fileDoc = fromFile(
      "main.ts",
      { kind: "workspace", rootId: "root", path: "src/main.ts" },
      decodeFile(bytes("clean\r\n")),
    );
    const edited = { ...fileDoc, id: "edited", text: "changed\n" };
    const scratch = { ...newDoc("Untitled 1"), text: "scratch" };
    const huge = { ...newDoc("Untitled 2"), text: "x".repeat(RECOVERY_LIMIT + 1) };
    const gone = fromFile("gone.ts", { kind: "file", handleId: "missing" }, decodeFile(bytes("g")));
    const docs = [fileDoc, edited, scratch, huge, gone];
    await recovery.saveIndex(docs, scratch.id);
    for (const doc of docs) await recovery.saveDoc(doc);
    // Clean files keep no copy; the huge one keeps only its tab.
    expect(storage.has(`doc/${fileDoc.id}`)).toBe(false);
    expect(storage.get(`doc/${edited.id}`)).toBe("changed\n");
    expect(storage.has(`doc/${huge.id}`)).toBe(false);

    const read = (source: Source): Promise<Decoded | null> =>
      Promise.resolve(source.kind === "workspace" ? decodeFile(bytes("clean\r\n")) : null);
    const restored = await recovery.restore(read);
    expect(restored.active).toBe(scratch.id);
    expect(restored.lost).toEqual(["Untitled 2"]);
    expect(restored.docs.map((doc) => [doc.name, doc.text, isDirty(doc)])).toEqual([
      ["main.ts", "clean\n", false],
      ["main.ts", "changed\n", true],
      ["Untitled 1", "scratch", true],
    ]);
    expect(restored.docs[0]).toMatchObject({ eol: "crlf", savedEol: "crlf" });
  });

  it("ignores stored tabs it does not understand", async () => {
    const { app, storage } = fakeApp();
    storage.set("tabs", { docs: [{ id: 3 }, null, "x"], active: 1 });
    expect(await new Recovery(app).restore(() => Promise.resolve(null))).toEqual({
      docs: [],
      active: null,
      lost: [],
    });
  });
});
