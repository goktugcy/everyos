import { open, readdir, stat, type FileHandle } from "node:fs/promises";

/** procfs/sysfs files are small; read them in small chunks (see readBytesOrNull). */
const READ_CHUNK_BYTES = 4096;

/**
 * Reads at most `maxBytes` of a file, returning null when it is missing or
 * unreadable. procfs and sysfs report a size of 0, so `readFile` would
 * allocate 64 KiB per file and read everything; with hundreds of /proc/<pid>
 * files per process listing that inflated the agent's RSS on a Raspberry Pi
 * by ~70 MiB that the allocator never returned. This reads small chunks and
 * stops at the limit.
 */
export async function readBytesOrNull(path: string, maxBytes = 64 * 1024): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return Buffer.concat(chunks, total);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reads a small text file, returning null when it is missing or unreadable. */
export async function readTextOrNull(path: string, maxBytes = 64 * 1024): Promise<string | null> {
  return (await readBytesOrNull(path, maxBytes))?.toString("utf8") ?? null;
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type PathKind = "file" | "directory" | "socket" | "other" | "missing" | "denied";

export async function pathKind(path: string): Promise<PathKind> {
  try {
    const info = await stat(path);
    if (info.isSocket()) return "socket";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "denied" : "missing";
  }
}

export async function listDirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
