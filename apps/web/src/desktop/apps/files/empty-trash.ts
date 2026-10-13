import { filesApi } from "./lib.ts";

export class IncompleteTrashListingError extends Error {}

/** Uses the existing permissioned, audited delete operation in batches across every root. */
export async function deleteTrashContents(assertActive: () => void): Promise<void> {
  assertActive();
  let listing = await filesApi.trash();
  let previous = new Set<string>();
  for (;;) {
    assertActive();
    const keys = listing.entries.map((item) => `${item.root}:${item.id}`);
    if ((listing.truncated && keys.length === 0) || keys.some((key) => previous.has(key)))
      throw new IncompleteTrashListingError("Trash listing made no progress");
    for (const root of new Set(listing.entries.map((item) => item.root))) {
      const ids = listing.entries.filter((item) => item.root === root).map((item) => item.id);
      for (let start = 0; start < ids.length; start += 500) {
        assertActive();
        await filesApi.deleteTrash(root, ids.slice(start, start + 500));
      }
    }
    if (!listing.truncated) return;
    previous = new Set(keys);
    assertActive();
    listing = await filesApi.trash();
  }
}
