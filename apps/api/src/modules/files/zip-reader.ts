import { Transform } from "node:stream";
import {
  Reader,
  ZipReader,
  ERR_INVALID_PASSWORD,
  ERR_INVALID_AUTHENTICATION_CODE,
  ERR_INVALID_CRC32,
  ERR_ENCRYPTED,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js/index-native.js";
import type { FileArchiveListing } from "@everyos/shared";
import { MAX_FILE_ARCHIVE_BYTES, MAX_FILE_ARCHIVE_ENTRIES } from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import type { FileView } from "./file-view.ts";

export const MAX_ZIP_ENTRIES = MAX_FILE_ARCHIVE_ENTRIES;
export const MAX_ZIP_BYTES = MAX_FILE_ARCHIVE_BYTES;
export const invalidZip = () =>
  new ApiError(400, "FILES_ARCHIVE_INVALID", "Invalid or unsafe ZIP archive");
export const zipLimit = () => new ApiError(413, "FILES_ARCHIVE_LIMIT", "Archive limits exceeded");

/** ZIP paths are data, never host paths; reject aliases before creating any output. */
export function zipPath(value: string): string {
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = path.split("/");
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    parts.length > 64 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:]/.test(part) ||
        Array.from(part).some((char) => char.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        Buffer.byteLength(part) > 255 ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw invalidZip();
  return path;
}

export class ZipNames {
  readonly entries = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
  #bytes = 0;
  add(path: string, directory: boolean): void {
    const parts = zipPath(path).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("/");
      const key = name.normalize("NFC").toLowerCase();
      const isDirectory = i < parts.length || directory;
      const explicit = i === parts.length;
      const old = this.entries.get(key);
      if (
        old &&
        (old.path !== name ||
          old.directory !== isDirectory ||
          (explicit && old.explicit && !isDirectory))
      )
        throw invalidZip();
      if (!old) this.#bytes += Buffer.byteLength(name);
      if (this.#bytes > 8 * 1024 ** 2) throw zipLimit();
      this.entries.set(key, {
        path: name,
        directory: isDirectory,
        explicit: explicit || old?.explicit === true,
      });
      if (this.entries.size > MAX_ZIP_ENTRIES) throw zipLimit();
    }
  }
}

type Opened = Awaited<ReturnType<FileView["openFile"]>>;
const MAX_METADATA_BYTES = 16 * 1024 ** 2;

/** Keep random access scoped to one transfer and bound allocations before the parser reads metadata. */
class ViewReader extends Reader<unknown> {
  readonly file: Opened;
  readonly signal: AbortSignal;
  constructor(file: Opened, signal: AbortSignal) {
    super(undefined);
    this.file = file;
    this.signal = signal;
    this.size = file.size;
  }
  override async readUint8Array(start: number, length: number): Promise<Uint8Array> {
    this.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 0 ||
      start + length > this.size
    )
      throw invalidZip();
    if (length > MAX_METADATA_BYTES) throw zipLimit();
    const result = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      this.signal.throwIfAborted();
      const data = await this.file.readAt(start + read, Math.min(48 * 1024, length - read));
      if (!data.length) throw invalidZip();
      result.set(data, read);
      read += data.length;
    }
    return result;
  }
}

export interface OpenZip {
  entries: Entry[];
  listing: FileArchiveListing;
  names: ZipNames;
  close(): Promise<void>;
}

export function zipReadError(error: unknown, encrypted = false): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message === ERR_ENCRYPTED)
    return new ApiError(400, "FILES_ARCHIVE_PASSWORD_REQUIRED", "An archive password is required");
  if (
    message === ERR_INVALID_PASSWORD ||
    (encrypted && [ERR_INVALID_AUTHENTICATION_CODE, ERR_INVALID_CRC32].includes(message))
  )
    return new ApiError(
      400,
      "FILES_ARCHIVE_PASSWORD_INVALID",
      "The password or encrypted archive integrity could not be verified",
    );
  const invalid = invalidZip();
  invalid.cause = error;
  return invalid;
}

export async function openZip(
  files: FileView,
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<OpenZip> {
  const file = await files.openFile(root, path);
  let zip: ZipReader<unknown> | null = null;
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      try {
        await zip?.close();
      } finally {
        await file.handle.close();
      }
    })());
  try {
    if (file.size > MAX_ZIP_BYTES) throw zipLimit();
    signal.throwIfAborted();
    zip = new ZipReader(new ViewReader(file, signal), {
      useWebWorkers: false,
      checkSignature: true,
      checkOverlappingEntry: true,
      strictness: "strict",
      filenameValidation: "strict",
    });
    const entries: Entry[] = [];
    const names = new ZipNames();
    let bytes = 0;
    let metadataBytes = 0;
    let encrypted = false;
    for await (const entry of zip.getEntriesGenerator()) {
      signal.throwIfAborted();
      if (entries.length >= MAX_ZIP_ENTRIES) throw zipLimit();
      metadataBytes +=
        46 + entry.rawFilename.length + entry.rawExtraField.length + entry.rawComment.length;
      if (metadataBytes > MAX_METADATA_BYTES) throw zipLimit();
      if ((entry.rawBitFlag ?? 0) & 0x40 || ![0, 8].includes(entry.compressionMethod))
        throw new ApiError(
          400,
          "FILES_ARCHIVE_UNSUPPORTED",
          "Unsupported ZIP encryption or compression",
        );
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      const directory = entry.directory;
      if (mode && mode !== (directory ? 0o040000 : 0o100000))
        throw new ApiError(
          400,
          "FILES_ARCHIVE_UNSUPPORTED",
          "Links and special files are not supported",
        );
      const name = zipPath(entry.filename);
      names.add(name, directory);
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        !Number.isSafeInteger(entry.compressedSize) ||
        entry.compressedSize < 0 ||
        (directory && entry.uncompressedSize !== 0)
      )
        throw invalidZip();
      bytes += entry.uncompressedSize;
      if (bytes > MAX_ZIP_BYTES) throw zipLimit();
      encrypted ||= entry.encrypted;
      entries.push(entry);
    }
    return {
      entries,
      names,
      close,
      listing: {
        root,
        path,
        bytes,
        encrypted,
        entries: entries.map((entry) => ({
          path: zipPath(entry.filename),
          type: entry.directory ? "directory" : "file",
          size: entry.uncompressedSize,
        })),
      },
    };
  } catch (error) {
    await close().catch(() => undefined);
    if (signal.aborted) throw error;
    throw zipReadError(error);
  }
}

/** zip.js verifies CRC/AES authentication; retain an independent output-size budget before upload commit. */
export function checkedZipStream(entry: FileEntry, progress: (bytes: number) => void): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > entry.uncompressedSize || bytes > MAX_ZIP_BYTES) return callback(zipLimit());
      progress(chunk.length);
      callback(null, chunk);
    },
    flush(callback) {
      callback(bytes === entry.uncompressedSize ? null : invalidZip());
    },
  });
}
