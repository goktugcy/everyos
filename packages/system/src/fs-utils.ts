import { readdir, readFile, stat } from "node:fs/promises";

/** Reads a small text file, returning null when it is missing or unreadable. */
export async function readTextOrNull(path: string, maxBytes = 64 * 1024): Promise<string | null> {
  try {
    const content = await readFile(path);
    return content.subarray(0, maxBytes).toString("utf8");
  } catch {
    return null;
  }
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
