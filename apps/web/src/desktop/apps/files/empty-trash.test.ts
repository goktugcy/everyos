import type { TrashEntry } from "@everyos/shared";
import { beforeEach, expect, it, vi } from "vitest";
import { filesApi } from "./lib.ts";
import { deleteTrashContents, IncompleteTrashListingError } from "./empty-trash.ts";

vi.mock("./lib.ts", () => ({ filesApi: { trash: vi.fn(), deleteTrash: vi.fn() } }));
const entry = (index: number, root = "home"): TrashEntry => ({
  id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  root,
  path: `note-${index}.txt`,
  name: `note-${index}.txt`,
  type: "file",
  size: 1,
  deletedAt: 1,
});
beforeEach(() => vi.resetAllMocks());

it("empties every root in validated batch sizes and continues beyond a truncated listing", async () => {
  vi.mocked(filesApi.trash)
    .mockResolvedValueOnce({
      entries: [...Array.from({ length: 501 }, (_, i) => entry(i)), entry(502, "shared")],
      truncated: true,
    })
    .mockResolvedValueOnce({ entries: [entry(503)], truncated: false });
  await deleteTrashContents(() => undefined);
  const batches = vi.mocked(filesApi.deleteTrash).mock.calls;
  expect(batches.map(([root, ids]) => [root, ids.length])).toEqual([
    ["home", 500],
    ["home", 1],
    ["shared", 1],
    ["home", 1],
  ]);
  expect(batches.flatMap(([, ids]) => ids)).toHaveLength(503);
  expect(filesApi.trash).toHaveBeenCalledTimes(2);
});

it("stops between batches when the original session is no longer authorized", async () => {
  vi.mocked(filesApi.trash).mockResolvedValue({
    entries: Array.from({ length: 501 }, (_, i) => entry(i)),
    truncated: false,
  });
  let active = true;
  vi.mocked(filesApi.deleteTrash).mockImplementation(() => {
    active = false;
    return Promise.resolve();
  });
  await expect(
    deleteTrashContents(() => {
      if (!active) throw new Error("session ended");
    }),
  ).rejects.toThrow("session ended");
  expect(filesApi.deleteTrash).toHaveBeenCalledTimes(1);
  expect(filesApi.deleteTrash).toHaveBeenCalledWith("home", expect.any(Array));
});

it("reports incomplete or repeated pages instead of claiming success or looping indefinitely", async () => {
  vi.mocked(filesApi.trash).mockResolvedValue({ entries: [entry(1)], truncated: true });
  await expect(deleteTrashContents(() => undefined)).rejects.toBeInstanceOf(
    IncompleteTrashListingError,
  );
  expect(filesApi.deleteTrash).toHaveBeenCalledTimes(1);
  vi.mocked(filesApi.trash).mockResolvedValue({ entries: [], truncated: true });
  await expect(deleteTrashContents(() => undefined)).rejects.toBeInstanceOf(
    IncompleteTrashListingError,
  );
  expect(filesApi.deleteTrash).toHaveBeenCalledTimes(1);
});
