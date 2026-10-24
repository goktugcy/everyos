import type { DiskUsage } from "@everyos/app-sdk/protocol";
import type { FileView } from "../files/file-view.ts";

const LIMITS = { entries: 50_000, depth: 32, ms: 15_000, largest: 50 };

/** Measure only a shared folder, through the person's file view; never follow links. */
export async function diskUsage(
  view: Pick<FileView, "list">,
  root: string,
  base: string,
): Promise<DiskUsage> {
  const deadline = Date.now() + LIMITS.ms;
  const result: DiskUsage = {
    total: 0,
    files: 0,
    folders: 0,
    truncated: false,
    children: [],
    largest: [],
    types: [],
  };
  const types = new Map<string, { count: number; size: number }>();
  let visited = 0;
  const stopped = () => {
    if (Date.now() >= deadline || visited >= LIMITS.entries) {
      result.truncated = true;
      return true;
    }
    return false;
  };
  const addFile = (name: string, path: string, size: number) => {
    result.files++;
    const dot = name.lastIndexOf(".");
    const extension =
      dot > 0
        ? name
            .slice(dot + 1)
            .toLowerCase()
            .slice(0, 16)
        : "";
    const type = types.get(extension) ?? { count: 0, size: 0 };
    type.count++;
    type.size += size;
    types.set(extension, type);
    result.largest.push({ path: path.slice(base ? base.length + 1 : 0), size });
    if (result.largest.length > LIMITS.largest * 2) {
      result.largest.sort((a, b) => b.size - a.size);
      result.largest.length = LIMITS.largest;
    }
  };
  const walk = async (
    path: string,
    depth: number,
    initial?: Awaited<ReturnType<FileView["list"]>>,
  ): Promise<{ size: number; items: number }> => {
    let size = 0;
    let items = 0;
    if (depth > LIMITS.depth || stopped()) {
      result.truncated = true;
      return { size, items };
    }
    // Losing access midway is a partial scan, never a successfully measured empty folder.
    const listing = initial ?? (await view.list(root, path, true).catch(() => null));
    if (!listing) {
      result.truncated = true;
      return { size, items };
    }
    if (listing.truncated) result.truncated = true;
    for (const entry of listing.entries) {
      if (stopped()) break;
      visited++;
      const child = path ? `${path}/${entry.name}` : entry.name;
      let measured: { size: number; items: number } | null = null;
      if (entry.type === "file") {
        addFile(entry.name, child, entry.size);
        measured = { size: entry.size, items: 1 };
      } else if (entry.type === "directory") {
        result.folders++;
        const inner = await walk(child, depth + 1);
        measured = { size: inner.size, items: inner.items + 1 };
      }
      if (!measured) continue;
      size += measured.size;
      items += measured.items;
      if (depth === 0)
        result.children.push({
          name: entry.name,
          kind: entry.type === "file" ? "file" : "directory",
          size: measured.size,
          items: entry.type === "file" ? 1 : measured.items - 1,
        });
    }
    return { size, items };
  };
  // An inaccessible chosen folder is an error; inaccessible descendants are partial results.
  const top = await view.list(root, base, true);
  const { size } = await walk(base, 0, top);
  result.total = size;
  result.children.sort((a, b) => b.size - a.size);
  result.largest.sort((a, b) => b.size - a.size);
  result.largest.length = Math.min(result.largest.length, LIMITS.largest);
  result.types = [...types]
    .map(([extension, value]) => ({ extension, ...value }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 50);
  return result;
}
