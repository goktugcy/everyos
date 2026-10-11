import type { Writable } from "node:stream";

/*
 * A small POSIX tar (ustar + pax) implementation for Otuken backups. It writes
 * and reads regular files, directories and symbolic links only; the readers of
 * backups decide what else to reject. No external `tar` binary is involved, so
 * the same code runs in the unprivileged API and in the agent.
 */

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface TarHeader {
  name: string;
  type: TarEntryType;
  /** Content length; 0 for anything but files. */
  size: number;
  /** Permission bits (including setuid/setgid/sticky, as stored). */
  mode: number;
  uid: number;
  gid: number;
  /** Modification time in milliseconds. */
  mtime: number;
  /** Target of symbolic and hard links. */
  linkname: string | null;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const BLOCK = 512;
const END = Buffer.alloc(BLOCK * 2);
const OCTAL_12 = 0o77777777777;
const OCTAL_8 = 0o7777777;
const TYPEFLAGS: Record<"file" | "directory" | "symlink", string> = {
  file: "0",
  directory: "5",
  symlink: "2",
};

export const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** Truncates to at most `bytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(value: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const char of value) {
    const length = Buffer.byteLength(char);
    if (used + length > bytes) break;
    out += char;
    used += length;
  }
  return out;
}

/** Splits a long name into ustar `prefix` and `name`, or null when it needs pax. */
function ustarName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", name };
  for (let index = name.indexOf("/"); index !== -1; index = name.indexOf("/", index + 1)) {
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest)
      return { prefix, name: rest };
  }
  return null;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

function block(fields: {
  name: string;
  prefix?: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname?: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(fields.name, 0, 100, "utf8");
  header.write(octal(fields.mode & 0o7777, 8), 100, 8, "ascii");
  header.write(octal(fields.uid, 8), 108, 8, "ascii");
  header.write(octal(fields.gid, 8), 116, 8, "ascii");
  header.write(octal(fields.size, 12), 124, 12, "ascii");
  header.write(octal(Math.max(0, Math.floor(fields.mtime / 1000)), 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(fields.typeflag, 156, 1, "ascii");
  header.write(fields.linkname ?? "", 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(fields.prefix ?? "", 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return header;
}

export type TarWriteHeader = Pick<TarHeader, "name" | "mode" | "mtime"> &
  Partial<Pick<TarHeader, "uid" | "gid">> &
  ({ type: "file"; size: number } | { type: "directory" } | { type: "symlink"; linkname: string });

/** The header blocks (with a pax extension when needed) for one entry. */
export function encodeHeader(header: TarWriteHeader): Buffer {
  const name = header.name;
  if (!name || name.includes("\0")) throw new TarError("Invalid entry name");
  const size = header.type === "file" ? header.size : 0;
  const uid = header.uid ?? 0;
  const gid = header.gid ?? 0;
  const linkname = header.type === "symlink" ? header.linkname : "";
  if (linkname.includes("\0")) throw new TarError("Invalid link target");
  const split = ustarName(name);
  const pax: string[] = [];
  if (!split) pax.push(paxRecord("path", name));
  if (Buffer.byteLength(linkname) > 100) pax.push(paxRecord("linkpath", linkname));
  if (size > OCTAL_12) pax.push(paxRecord("size", String(size)));
  if (uid > OCTAL_8) pax.push(paxRecord("uid", String(uid)));
  if (gid > OCTAL_8) pax.push(paxRecord("gid", String(gid)));
  const main = block({
    name: split ? split.name : truncateUtf8(name, 100),
    prefix: split?.prefix ?? "",
    mode: header.mode,
    uid: uid > OCTAL_8 ? 0 : uid,
    gid: gid > OCTAL_8 ? 0 : gid,
    size: size > OCTAL_12 ? 0 : size,
    mtime: header.mtime,
    typeflag: TYPEFLAGS[header.type],
    linkname: truncateUtf8(linkname, 100),
  });
  if (pax.length === 0) return main;
  const body = Buffer.from(pax.join(""), "utf8");
  const base = name.split("/").pop() ?? "entry";
  const paxHeader = block({
    name: truncateUtf8(`PaxHeaders/${base}`, 100),
    mode: 0o644,
    uid: 0,
    gid: 0,
    size: body.length,
    mtime: header.mtime,
    typeflag: "x",
  });
  return Buffer.concat([paxHeader, body, Buffer.alloc(padding(body.length)), main]);
}

/** Exact size of an uncompressed archive of these entries (e.g. for Content-Length). */
export function archiveSize(headers: readonly TarWriteHeader[]): number {
  let total = END.length;
  for (const header of headers) {
    const size = header.type === "file" ? header.size : 0;
    total += encodeHeader(header).length + size + padding(size);
  }
  return total;
}

/**
 * Turns a writable stream into an async sink that respects backpressure. It
 * fails as soon as the stream errors or closes (a client went away), instead
 * of waiting forever for a `drain` that never comes.
 */
export function sinkTo(stream: Writable): (chunk: Buffer) => Promise<void> {
  return async (chunk) => {
    if (stream.destroyed || stream.writableEnded) throw new TarError("Output closed");
    if (stream.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        stream.off("drain", drained);
        stream.off("error", failed);
        stream.off("close", closed);
      };
      const drained = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => {
        cleanup();
        reject(new TarError("Output closed"));
      };
      stream.on("drain", drained);
      stream.on("error", failed);
      stream.on("close", closed);
    });
  };
}

/** Streams entries into a tar archive through `write`. */
export class TarWriter {
  readonly #write: (chunk: Buffer) => Promise<void>;
  #ended = false;

  constructor(write: (chunk: Buffer) => Promise<void>) {
    this.#write = write;
  }

  async directory(header: Omit<Extract<TarWriteHeader, { type: "directory" }>, "type">) {
    await this.#header({ ...header, type: "directory" });
  }

  async symlink(header: Omit<Extract<TarWriteHeader, { type: "symlink" }>, "type">) {
    await this.#header({ ...header, type: "symlink" });
  }

  /** Writes a file; fails when the content is not exactly `size` bytes (it changed meanwhile). */
  async file(
    header: Omit<Extract<TarWriteHeader, { type: "file" }>, "type">,
    content: Buffer | AsyncIterable<Buffer | Uint8Array>,
  ): Promise<void> {
    await this.#header({ ...header, type: "file" });
    let written = 0;
    if (Buffer.isBuffer(content)) {
      written = content.length;
      if (written === header.size && written > 0) await this.#write(content);
    } else {
      for await (const raw of content) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        written += chunk.length;
        if (written > header.size) break;
        await this.#write(chunk);
      }
    }
    if (written !== header.size) throw new TarError(`File changed while archiving: ${header.name}`);
    const pad = padding(header.size);
    if (pad) await this.#write(Buffer.alloc(pad));
  }

  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    await this.#write(END);
  }

  async #header(header: TarWriteHeader): Promise<void> {
    if (this.#ended) throw new TarError("Archive already ended");
    await this.#write(encodeHeader(header));
  }
}

/* ---------------------------------------------------------------- reading */

export interface TarReadEntry extends TarHeader {
  /**
   * The file's content. Consume it before asking for the next entry; whatever
   * is left unread is skipped.
   */
  content: AsyncIterable<Buffer>;
}

export interface TarReadLimits {
  /** Maximum number of entries (default 1,000,000). */
  maxEntries?: number;
  /** Maximum total content size in bytes (default 1 TiB). */
  maxBytes?: number;
}

type TarSource = AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array>;

class ByteReader {
  readonly #iterator: AsyncIterator<Buffer | Uint8Array | string>;
  #buffer: Buffer = Buffer.alloc(0);
  #done = false;
  constructor(source: TarSource) {
    if (Symbol.asyncIterator in source) this.#iterator = source[Symbol.asyncIterator]();
    else {
      const iterator = source[Symbol.iterator]();
      this.#iterator = { next: () => Promise.resolve(iterator.next()) };
    }
  }
  async #fill(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#iterator.next();
    if (next.done) {
      this.#done = true;
      return false;
    }
    const chunk =
      typeof next.value === "string" ? Buffer.from(next.value) : Buffer.from(next.value);
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    return true;
  }
  /** Exactly `length` bytes, or null at a clean end of input. */
  async exact(length: number): Promise<Buffer | null> {
    while (this.#buffer.length < length) {
      if (!(await this.#fill())) {
        if (this.#buffer.length === 0) return null;
        throw new TarError("Archive is truncated");
      }
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }
  /** Up to `max` bytes (at least one), failing at end of input. */
  async some(max: number): Promise<Buffer> {
    if (this.#buffer.length === 0 && !(await this.#fill()))
      throw new TarError("Archive is truncated");
    const out = this.#buffer.subarray(0, Math.min(max, this.#buffer.length));
    this.#buffer = this.#buffer.subarray(out.length);
    return out;
  }
  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) left -= (await this.some(left)).length;
  }
}

function readNumber(field: Buffer): number {
  // GNU base-256 for values that do not fit in octal.
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    if (!Number.isSafeInteger(value)) throw new TarError("Invalid number in archive header");
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("Invalid number in archive header");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarError("Invalid number in archive header");
  return value;
}

function readString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw new TarError("Invalid pax header");
    const length = Number(body.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length)
      throw new TarError("Invalid pax header");
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new TarError("Invalid pax header");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

const MAX_META = 1024 * 1024;

/**
 * Parses a tar stream. pax ('x'), GNU long name ('L'/'K') and global pax
 * headers are understood; other entry types are reported as "other" so the
 * caller can refuse them. Header checksums are verified.
 */
export async function* readTar(
  source: TarSource,
  limits: TarReadLimits = {},
): AsyncGenerator<TarReadEntry> {
  const reader = new ByteReader(source);
  const maxEntries = limits.maxEntries ?? 1_000_000;
  const maxBytes = limits.maxBytes ?? 1024 ** 4;
  let entries = 0;
  let total = 0;
  let pax = new Map<string, string>();
  let longName: string | null = null;
  let longLink: string | null = null;
  for (;;) {
    const header = await reader.exact(BLOCK);
    if (!header) throw new TarError("Archive has no end marker");
    if (header.every((byte) => byte === 0)) return;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (readNumber(header.subarray(148, 156)) !== sum)
      throw new TarError("Not a tar archive (bad header checksum)");
    const typeflag = String.fromCharCode(header[156]!);
    const size = readNumber(header.subarray(124, 136));
    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      if (size > MAX_META) throw new TarError("Archive metadata is too large");
      const body = size ? await reader.exact(size) : Buffer.alloc(0);
      if (!body) throw new TarError("Archive is truncated");
      await reader.skip(padding(size));
      if (typeflag === "x") pax = parsePax(body);
      else if (typeflag === "L") longName = readString(body);
      else if (typeflag === "K") longLink = readString(body);
      continue;
    }
    const magic = header.subarray(257, 263).toString("ascii");
    const prefix = magic.startsWith("ustar") ? readString(header.subarray(345, 500)) : "";
    let name =
      pax.get("path") ??
      longName ??
      (prefix ? `${prefix}/` : "") + readString(header.subarray(0, 100));
    const linkname = pax.get("linkpath") ?? longLink ?? readString(header.subarray(157, 257));
    const paxSize = pax.get("size");
    const entrySize = paxSize !== undefined ? Number(paxSize) : size;
    const numeric = (key: string, fallback: number) => {
      const value = pax.get(key);
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new TarError("Invalid pax value");
      return parsed;
    };
    const uid = numeric("uid", readNumber(header.subarray(108, 116)));
    const gid = numeric("gid", readNumber(header.subarray(116, 124)));
    const mtime = numeric("mtime", readNumber(header.subarray(136, 148))) * 1000;
    pax = new Map();
    longName = null;
    longLink = null;
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) throw new TarError("Invalid entry size");
    const type: TarEntryType =
      typeflag === "0" || typeflag === "\0" || typeflag === "7"
        ? "file"
        : typeflag === "5"
          ? "directory"
          : typeflag === "2"
            ? "symlink"
            : typeflag === "1"
              ? "hardlink"
              : "other";
    if (name.startsWith("./")) name = name.slice(2);
    if (type === "directory") name = name.replace(/\/+$/, "");
    if (++entries > maxEntries) throw new TarError("Archive has too many entries");
    // Only file content occupies data blocks for the types we accept.
    const dataSize = type === "file" || type === "other" ? entrySize : 0;
    total += dataSize;
    if (total > maxBytes) throw new TarError("Archive is too large");
    let remaining = dataSize;
    const content = (async function* () {
      while (remaining > 0) {
        const chunk = await reader.some(Math.min(remaining, 256 * 1024));
        remaining -= chunk.length;
        yield chunk;
      }
    })();
    yield {
      name,
      type,
      size: dataSize,
      mode: readNumber(header.subarray(100, 108)) & 0o7777,
      uid,
      gid,
      mtime,
      linkname: type === "symlink" || type === "hardlink" ? linkname : null,
      content,
    };
    if (remaining > 0) await reader.skip(remaining);
    remaining = 0;
    await reader.skip(padding(dataSize));
  }
}

/**
 * Normalizes an archive member name, or returns null when it could escape the
 * extraction directory (absolute, `..`, empty or `.` components, NUL bytes).
 */
export function safeRelativePath(name: string): string | null {
  if (!name || name.length > 4096 || name.includes("\0") || name.startsWith("/")) return null;
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}
