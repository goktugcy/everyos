import { crc32, inflateRawSync } from "node:zlib";
import { CatalogError } from "./fetch.ts";

export function safePath(path: string): string {
  if (
    !path ||
    path.length > 1024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  )
    throw new CatalogError("unsafe-path");
  const parts = path.split("/");
  if (parts.some((part) => part === "." || part === "..")) throw new CatalogError("unsafe-path");
  return path;
}

/** Metadata is read in memory; archive paths are never extracted on the host. */
export function readZip(input: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let end = -1;
  for (let i = input.length - 22; i >= Math.max(0, input.length - 65_557); i--) {
    if (
      input.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + input.readUInt16LE(i + 20) === input.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || input.readUInt16LE(end + 4) !== 0 || input.readUInt16LE(end + 6) !== 0)
    throw new CatalogError("invalid-archive");
  const count = input.readUInt16LE(end + 10);
  let offset = input.readUInt32LE(end + 16);
  if (
    count > 20_000 ||
    offset + input.readUInt32LE(end + 12) !== end ||
    input.readUInt16LE(end + 8) !== count
  )
    throw new CatalogError("invalid-archive");
  let total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || input.readUInt32LE(offset) !== 0x02014b50)
      throw new CatalogError("invalid-archive");
    const flags = input.readUInt16LE(offset + 8);
    const method = input.readUInt16LE(offset + 10);
    const compressed = input.readUInt32LE(offset + 20);
    const size = input.readUInt32LE(offset + 24);
    const nameSize = input.readUInt16LE(offset + 28);
    const extra = input.readUInt16LE(offset + 30);
    const comment = input.readUInt16LE(offset + 32);
    const mode = input.readUInt32LE(offset + 38) >>> 16;
    const local = input.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extra + comment;
    if (next > end || flags & 1 || (mode & 0xf000) === 0xa000 || local + 30 > offset)
      throw new CatalogError("unsafe-archive");
    const path = safePath(input.subarray(offset + 46, offset + 46 + nameSize).toString("utf8"));
    if (names.has(path)) throw new CatalogError("duplicate-path");
    names.add(path);
    if (/\.(ya?ml|json|md)$/i.test(path)) {
      total += size;
      if (size > 512 * 1024 || total > 16 * 1024 * 1024) throw new CatalogError("too-large");
      if (input.readUInt32LE(local) !== 0x04034b50 || input.readUInt16LE(local + 8) !== method)
        throw new CatalogError("invalid-archive");
      const localName = input.readUInt16LE(local + 26);
      const start = local + 30 + localName + input.readUInt16LE(local + 28);
      if (
        start + compressed > input.readUInt32LE(end + 16) ||
        input.subarray(local + 30, local + 30 + localName).toString("utf8") !== path
      )
        throw new CatalogError("invalid-archive");
      const data = input.subarray(start, start + compressed);
      const content =
        method === 0
          ? data
          : method === 8
            ? inflateRawSync(data, { maxOutputLength: 512 * 1024 })
            : null;
      if (!content || content.length !== size || crc32(content) !== input.readUInt32LE(offset + 16))
        throw new CatalogError("invalid-archive");
      files.set(path, content.toString("utf8"));
    }
    offset = next;
  }
  if (offset !== end) throw new CatalogError("invalid-archive");
  // GitHub ZIPs add one directory around the repository.
  const roots = new Set([...files.keys()].map((path) => path.split("/")[0]));
  if (roots.size === 1 && [...files.keys()].every((path) => path.includes("/")))
    return new Map([...files].map(([path, value]) => [path.slice(path.indexOf("/") + 1), value]));
  return files;
}
