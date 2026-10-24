import type { DirectoryEntry, FileHandle } from "@everyos/app-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  albumContent,
  galleryPreferences,
  manualPhoto,
  photos,
  relativePath,
  scanImages,
} from "../src/albums.ts";

const root: FileHandle = {
  id: "folder",
  name: "Photos",
  kind: "directory",
  size: null,
  type: null,
  writable: false,
  persistent: true,
};
const entry = (name: string, kind: "file" | "directory" = "file"): DirectoryEntry => ({
  name,
  kind,
  size: kind === "file" ? 1024 : null,
  modifiedAt: 1700000000000,
});
describe("Gallery albums", () => {
  it("validates album identities, paths, entry sizes and limits restored per-album data", () => {
    expect(
      galleryPreferences({
        albums: [
          { id: "../outside", name: "bad" },
          { id: "a", name: " Album " },
        ],
        current: "bad",
        sort: "arbitrary",
      }).albums,
    ).toEqual([{ id: "a", name: "Album" }]);
    expect(relativePath("../secret.png")).toBe(false);
    expect(relativePath("/outside.png")).toBe(false);
    expect(relativePath("nested/photo.png")).toBe(true);
    const items = Array.from({ length: 1000 }, (_, i) => ({
      key: `h${i}`,
      root: null,
      file: `h${i}`,
      path: "",
      name: "界".repeat(200) + i + ".png",
      size: 1,
      modified: 0,
      favorite: true,
    }));
    const value = albumContent({ items, roots: [], indexedAt: 1, partial: false });
    expect(value.partial).toBe(true);
    expect(value.items.length).toBeLessThan(1000);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(220 * 1024);
  });
  it("indexes only the chosen root, recurses into approved relative locations and labels read failures partial", async () => {
    const files = {
      list: vi.fn((_handle: FileHandle | string, path?: string) => {
        if (path === "nested") return Promise.resolve([entry("inside.jpg")]);
        if (path === "denied") return Promise.reject(new Error("denied"));
        return Promise.resolve([
          entry("cover.png"),
          entry("nested", "directory"),
          entry("denied", "directory"),
          entry("note.txt"),
        ]);
      }),
    };
    const result = await scanImages(files, root);
    expect(result.items.map((photo) => photo.path).toSorted()).toEqual([
      "cover.png",
      "nested/inside.jpg",
    ]);
    expect(result.partial).toBe(true);
    expect(files.list.mock.calls.every(([handle]) => handle === root)).toBe(true);
  });
  it("stops at image, traversal, depth, deadline and cancellation budgets", async () => {
    const many = await scanImages(
      { list: () => Promise.resolve(Array.from({ length: 1001 }, (_, n) => entry(`${n}.png`))) },
      root,
    );
    expect(many.items).toHaveLength(1000);
    expect(many.partial).toBe(true);
    const depth = await scanImages(
      { list: () => Promise.resolve([entry("nested", "directory")]) },
      root,
    );
    expect(depth.partial).toBe(true);
    expect(depth.visited).toBe(9);
    const count = await scanImages(
      { list: () => Promise.resolve(Array.from({ length: 20001 }, (_, n) => entry(`${n}.txt`))) },
      root,
    );
    expect(count.visited).toBe(20000);
    expect(count.partial).toBe(true);
    expect(
      (await scanImages({ list: () => Promise.resolve([]) }, root, { cancelled: () => true }))
        .partial,
    ).toBe(true);
    let time = 0;
    expect(
      (await scanImages({ list: () => Promise.resolve([]) }, root, { now: () => (time += 31000) }))
        .partial,
    ).toBe(true);
  });
  it("filters and sorts actual metadata without inventing modification times for selected files", () => {
    const selected = manualPhoto({ ...root, id: "one", kind: "file", name: "one.png", size: 2 })!;
    expect(selected.modified).toBe(0);
    const content = albumContent({
      roots: [],
      items: [
        selected,
        {
          ...selected,
          key: "two",
          file: "two",
          name: "two.jpg",
          size: 9,
          modified: 1,
          favorite: true,
        },
      ],
    });
    expect(photos(content, "", false, "size")[0]!.name).toBe("two.jpg");
    expect(photos(content, "two", true, "name")).toHaveLength(1);
    expect(photos(content, "one", true, "name")).toHaveLength(0);
  });
});
