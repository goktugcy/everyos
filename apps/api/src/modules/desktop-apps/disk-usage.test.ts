import type { FileEntry, FileListing } from "@everyos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diskUsage } from "./disk-usage.ts";

const entry = (name: string, type: FileEntry["type"] = "file", size = 10): FileEntry => ({
  name,
  type,
  size,
  modifiedAt: 0,
  mode: "rw-r--r--",
  link: null,
});
const listing = (path: string, entries: FileEntry[], truncated = false): FileListing => ({
  root: "home",
  path,
  entries,
  truncated,
});
afterEach(() => vi.restoreAllMocks());

describe("scoped disk measurements", () => {
  it("counts nested files, sorts actual sizes and skips links without traversing outside the chosen base", async () => {
    const tree = new Map([
      [
        "chosen",
        listing("chosen", [
          entry("a", "directory"),
          entry("small.txt", "file", 2),
          entry("escape", "symlink", 900),
        ]),
      ],
      ["chosen/a", listing("chosen/a", [entry("movie.MKV", "file", 20), entry("b", "directory")])],
      ["chosen/a/b", listing("chosen/a/b", [entry(".env", "file", 3)])],
    ]);
    const list = vi.fn(async (_root: string, path: string) => {
      await Promise.resolve();
      if (!tree.has(path)) throw new Error("Outside scope");
      return tree.get(path)!;
    });
    const result = await diskUsage({ list }, "home", "chosen");
    expect(result).toMatchObject({ total: 25, files: 3, folders: 2, truncated: false });
    expect(result.children).toEqual([
      { name: "a", kind: "directory", size: 23, items: 3 },
      { name: "small.txt", kind: "file", size: 2, items: 1 },
    ]);
    expect(result.largest[0]).toEqual({ path: "a/movie.MKV", size: 20 });
    expect(result.types).toEqual([
      { extension: "mkv", count: 1, size: 20 },
      { extension: "", count: 1, size: 3 },
      { extension: "txt", count: 1, size: 2 },
    ]);
    expect(list.mock.calls.map((call) => call[1])).toEqual([...tree.keys()]);
  });

  it("labels unreadable descendants as partial but propagates an unreadable chosen root", async () => {
    const list = vi.fn(async (_root: string, path: string) => {
      await Promise.resolve();
      if (path) throw new Error("Permission denied");
      return listing("", [entry("locked", "directory"), entry("readable", "file", 8)]);
    });
    expect(await diskUsage({ list }, "home", "")).toMatchObject({ total: 8, truncated: true });
    await expect(diskUsage({ list }, "home", "locked")).rejects.toThrow("Permission denied");
  });

  it("honors listing and depth limits without claiming omitted files were empty", async () => {
    const list = vi.fn((_root: string, path: string) =>
      Promise.resolve(listing(path, [entry("next", "directory")], path === "")),
    );
    const result = await diskUsage({ list }, "home", "");
    expect(result.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(33);
    expect(result.folders).toBe(33);
  });

  it("enforces a global entry budget including the chosen folder's direct children", async () => {
    const list = vi.fn((_root: string, path: string) =>
      Promise.resolve(
        listing(
          path,
          path === ""
            ? Array.from({ length: 20 }, (_, i) => entry(`folder-${i}`, "directory"))
            : Array.from({ length: 5000 }, (_, i) => entry(`file-${i}.txt`, "file", 1)),
        ),
      ),
    );
    const result = await diskUsage({ list }, "home", "");
    expect(result.truncated).toBe(true);
    expect(result.files + result.folders).toBe(50000);
    expect(list).toHaveBeenCalledTimes(11);
    expect(result.largest).toHaveLength(50);
    expect(result.total).toBe(result.files);
  });

  it("checks the deadline between direct entries as well as descending directories", async () => {
    let at = 0;
    vi.spyOn(Date, "now").mockImplementation(() => at);
    const entries = [entry("first", "file", 7), entry("last", "file", 99)];
    Object.defineProperty(entries[0], "size", {
      get() {
        at = 15001;
        return 7;
      },
    });
    const list = vi.fn(() => Promise.resolve(listing("", entries)));
    expect(await diskUsage({ list }, "home", "")).toMatchObject({
      total: 7,
      files: 1,
      truncated: true,
    });
  });
});
