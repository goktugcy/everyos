import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TrashEntry } from "@everyos/shared";
import { TrashEntrySchema } from "@everyos/shared/schemas";
import { ApiError, notFound } from "../../http/errors.ts";

export const TRASH_DIRECTORY = ".otuken-trash";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 5_000;

/** Trash stays on the source filesystem: moving an item never copies or deletes its data. */
export async function trashDirectory(root: string, owner: string, create = false): Promise<string> {
  if (!UUID.test(owner)) throw new ApiError(403, "FORBIDDEN", "No trash owner");
  let path = root;
  for (const name of [TRASH_DIRECTORY, owner]) {
    path = join(path, name);
    if (create)
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (await realpath(path)) !== path ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new ApiError(403, "FORBIDDEN", "Unsafe trash directory");
  }
  return path;
}

async function itemDirectory(base: string, id: string): Promise<string> {
  if (!UUID.test(id)) throw notFound("Trash item");
  const path = join(base, id);
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || (await realpath(path)) !== path) throw notFound("Trash item");
  return path;
}

export async function readTrashItem(base: string, root: string, id: string): Promise<TrashEntry> {
  const dir = await itemDirectory(base, id);
  const handle = await open(
    join(dir, "info.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16_384) throw notFound("Trash item");
    const parsed = TrashEntrySchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    if (!parsed.success || parsed.data.id !== id || parsed.data.root !== root)
      throw notFound("Trash item");
    await lstat(join(dir, "item"));
    return parsed.data;
  } finally {
    await handle.close();
  }
}

export async function listTrash(
  base: string,
  root: string,
): Promise<{ entries: TrashEntry[]; truncated: boolean }> {
  const names = await readdir(base);
  const entries: TrashEntry[] = [];
  for (const id of names.slice(0, LIMIT)) {
    if (!UUID.test(id)) continue;
    try {
      entries.push(await readTrashItem(base, root, id));
    } catch {
      // Interrupted moves (metadata without a payload) are never shown as recoverable files.
    }
  }
  return { entries, truncated: names.length > LIMIT };
}

export async function putInTrash(
  base: string,
  source: string,
  info: Omit<TrashEntry, "id" | "deletedAt">,
): Promise<void> {
  const entry: TrashEntry = { ...info, id: randomUUID(), deletedAt: Date.now() };
  const dir = join(base, entry.id);
  await mkdir(dir, { mode: 0o700 });
  let moved = false;
  try {
    const handle = await open(join(dir, "info.json"), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(source, join(dir, "item"));
    moved = true;
  } finally {
    if (!moved) await rm(dir, { recursive: true, force: true });
  }
}

export async function trashPayload(base: string, id: string): Promise<string> {
  return join(await itemDirectory(base, id), "item");
}

export async function discardTrashItem(base: string, id: string): Promise<void> {
  await rm(await itemDirectory(base, id), { recursive: true });
}
