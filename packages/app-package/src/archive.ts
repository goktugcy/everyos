import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline as pipe, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import { isPackagePath, type AppManifest } from "@everyos/app-manifest";
import { ManifestError, parseManifest } from "@everyos/app-manifest/schema";
import { readTar, safeRelativePath, TarWriter, type TarReadEntry } from "@everyos/system/archive";
import { contentTypeOf } from "./content-types.ts";

export const PACKAGE_LIMITS = {
  /** The `.eosapp` file itself. */
  packedBytes: 64 * 1024 * 1024,
  /** All file contents together, after decompression. */
  unpackedBytes: 256 * 1024 * 1024,
  entries: 10_000,
  manifestBytes: 64 * 1024,
};
export type PackageLimits = typeof PACKAGE_LIMITS;

export type PackageErrorCode =
  | "too-large"
  | "corrupt"
  | "unsafe-entry"
  | "unsupported-file"
  | "duplicate-entry"
  | "missing-manifest"
  | "invalid-manifest"
  | "missing-file";

export class PackageError extends Error {
  readonly code: PackageErrorCode;
  readonly detail: string | undefined;
  constructor(code: PackageErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PackageError";
    this.code = code;
    this.detail = detail;
  }
}

const MANIFEST = "manifest.json";

/** Files the manifest refers to; a package without any of them is incomplete. */
export function requiredFiles(manifest: AppManifest): string[] {
  const files = new Set([manifest.entry, manifest.icon, ...manifest.widgets.map((w) => w.entry)]);
  if (manifest.locales)
    for (const locale of manifest.locales.supported)
      files.add(`${manifest.locales.path}/${locale}.json`);
  return [...files];
}

function checkComplete(manifest: AppManifest, present: ReadonlySet<string>): void {
  for (const file of requiredFiles(manifest))
    if (!present.has(file)) throw new PackageError("missing-file", file);
}

function readManifest(bytes: Buffer): AppManifest {
  try {
    return parseManifest(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new PackageError(
      "invalid-manifest",
      error instanceof ManifestError ? error.message : "manifest.json is not valid JSON",
    );
  }
}

/** Every regular file of a build directory, sorted; links and unknown file types are refused. */
async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      // Editor and OS droppings (.DS_Store) are never part of an app.
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const path = relative(root, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        if (!isPackagePath(path)) throw new PackageError("unsafe-entry", path);
        if (!contentTypeOf(path)) throw new PackageError("unsupported-file", path);
        files.push(path);
      } else throw new PackageError("unsafe-entry", path);
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * Packs a build directory into `.eosapp` bytes. The output depends only on the files: entries are
 * sorted, times and owners are zeroed, and the gzip header names no OS or time.
 */
export async function packDirectory(
  dir: string,
  limits: PackageLimits = PACKAGE_LIMITS,
): Promise<{ bytes: Buffer; manifest: AppManifest; files: string[] }> {
  const files = await collectFiles(dir);
  if (!files.includes(MANIFEST)) throw new PackageError("missing-manifest");
  const manifest = readManifest(await readFile(join(dir, MANIFEST)));
  checkComplete(manifest, new Set(files));
  if (files.length > limits.entries) throw new PackageError("too-large", "too many files");
  const chunks: Buffer[] = [];
  const writer = new TarWriter((chunk) => {
    chunks.push(chunk);
    return Promise.resolve();
  });
  let total = 0;
  for (const path of files) {
    const content = await readFile(join(dir, path));
    total += content.length;
    if (total > limits.unpackedBytes) throw new PackageError("too-large", "contents");
    await writer.file({ name: path, mode: 0o644, mtime: 0, size: content.length }, content);
  }
  await writer.end();
  const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  bytes[9] = 255; // gzip OS field: "unknown", the same on every build machine.
  if (bytes.length > limits.packedBytes) throw new PackageError("too-large", "package");
  return { bytes, manifest, files };
}

/** Counts decompressed bytes so a small archive cannot inflate without bound. */
function inflateLimit(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(seen > max ? new PackageError("too-large", "decompressed size") : null, chunk);
    },
  });
}

async function* entriesOf(bytes: Buffer, limits: PackageLimits): AsyncGenerator<TarReadEntry> {
  if (bytes.length > limits.packedBytes) throw new PackageError("too-large", "package");
  // Headers and padding take at most 1.5 KiB per entry on top of the contents. `pipeline` (not
  // `pipe`) carries a corrupt gzip stream's error to the reader instead of leaving it unhandled.
  const inflated = pipe(
    Readable.from([bytes]),
    createGunzip(),
    inflateLimit(limits.unpackedBytes + limits.entries * 1536 + 1024 * 1024),
    () => undefined,
  );
  try {
    yield* readTar(inflated, { maxEntries: limits.entries, maxBytes: limits.unpackedBytes });
  } catch (error) {
    if (error instanceof PackageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PackageError(/too (large|many)/.test(message) ? "too-large" : "corrupt", message);
  } finally {
    inflated.destroy();
  }
}

/** Validates one entry's name and type; returns its path, or null for a directory entry. */
function entryPath(entry: TarReadEntry, seen: Set<string>): string | null {
  if (entry.type !== "file" && entry.type !== "directory")
    throw new PackageError("unsafe-entry", `${entry.name} (${entry.type})`);
  const name = safeRelativePath(entry.name);
  if (name === null || !isPackagePath(name)) throw new PackageError("unsafe-entry", entry.name);
  if (entry.type === "directory") return null;
  if (!contentTypeOf(name)) throw new PackageError("unsupported-file", name);
  // Case-insensitive file systems would merge "A.js" and "a.js".
  const key = name.toLowerCase();
  if (seen.has(key)) throw new PackageError("duplicate-entry", name);
  seen.add(key);
  return name;
}

async function collect(content: AsyncIterable<Buffer>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    size += chunk.length;
    if (size > max) throw new PackageError("too-large", MANIFEST);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads and validates a package without writing anything (tooling and registry checks). */
export async function inspectPackage(
  bytes: Buffer,
  limits: PackageLimits = PACKAGE_LIMITS,
  visit?: (entry: { path: string; size: number; content: AsyncIterable<Buffer> }) => Promise<void>,
): Promise<{ manifest: AppManifest; files: Array<{ path: string; size: number }> }> {
  const seen = new Set<string>();
  const files: Array<{ path: string; size: number }> = [];
  let manifest: AppManifest | null = null;
  for await (const entry of entriesOf(bytes, limits)) {
    const path = entryPath(entry, seen);
    if (path === null) continue;
    files.push({ path, size: entry.size });
    if (path === MANIFEST) {
      const content = await collect(entry.content, limits.manifestBytes);
      manifest = readManifest(content);
      if (visit) await visit({ path, size: entry.size, content: Readable.from([content]) });
    } else if (visit) await visit({ path, size: entry.size, content: entry.content });
  }
  if (!manifest) throw new PackageError("missing-manifest");
  checkComplete(manifest, new Set(files.map((file) => file.path)));
  return { manifest, files };
}

/**
 * Extracts a package into `target`, which must not exist yet. Every file is written read-only for
 * others and never executable; on any problem the partial directory is removed.
 */
export async function extractPackage(
  bytes: Buffer,
  target: string,
  limits: PackageLimits = PACKAGE_LIMITS,
): Promise<{ manifest: AppManifest; files: string[] }> {
  await mkdir(target, { mode: 0o755 });
  try {
    const seen = new Set<string>();
    const files: string[] = [];
    let manifest: AppManifest | null = null;
    for await (const entry of entriesOf(bytes, limits)) {
      const path = entryPath(entry, seen);
      if (path === null) continue;
      const destination = join(target, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      if (path === MANIFEST) {
        const content = await collect(entry.content, limits.manifestBytes);
        manifest = readManifest(content);
        await pipeline(
          Readable.from([content]),
          createWriteStream(destination, { flags: "wx", mode: 0o644 }),
        );
      } else {
        await pipeline(entry.content, createWriteStream(destination, { flags: "wx", mode: 0o644 }));
      }
      files.push(path);
    }
    if (!manifest) throw new PackageError("missing-manifest");
    checkComplete(manifest, new Set(files));
    return { manifest, files: files.sort() };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
