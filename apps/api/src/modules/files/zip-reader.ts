import { addAbortSignal, Readable, Transform } from "node:stream";
import { crc32 } from "node:zlib";
import { fromRandomAccessReaderPromise, RandomAccessReader, type Entry, type ZipFile } from "yauzl";
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
class ViewReader extends RandomAccessReader {
  readonly file: Opened;
  readonly signal: AbortSignal;
  readonly closeFile: () => Promise<void>;
  constructor(file: Opened, signal: AbortSignal, closeFile: () => Promise<void>) {
    super();
    this.file = file;
    this.signal = signal;
    this.closeFile = closeFile;
  }
  override _readStreamForRange(start: number, end: number): Readable {
    const file = this.file;
    const signal = this.signal;
    return addAbortSignal(
      signal,
      Readable.from(
        (async function* () {
          let position = start;
          while (position < end) {
            signal.throwIfAborted();
            const data = await file.readAt(position, Math.min(48 * 1024, end - position));
            if (!data.length) throw invalidZip();
            position += data.length;
            yield data;
          }
        })(),
      ),
    );
  }
  override close(callback: (error: Error | null) => void): void {
    void this.closeFile().then(
      () => callback(null),
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error("Cannot close archive")),
    );
  }
}

export interface OpenZip {
  zip: ZipFile;
  entries: Entry[];
  listing: FileArchiveListing;
  names: ZipNames;
  close(): Promise<void>;
}

export async function openZip(
  files: FileView,
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<OpenZip> {
  const file = await files.openFile(root, path);
  let zip: ZipFile | null = null;
  let closed = false;
  let fileClose: Promise<void> | null = null;
  const closeFile = () => (fileClose ??= file.handle.close());
  const close = async () => {
    if (closed) return;
    closed = true;
    zip?.close();
    await closeFile().catch(() => undefined);
  };
  try {
    if (file.size > MAX_ZIP_BYTES) throw zipLimit();
    signal.throwIfAborted();
    zip = await fromRandomAccessReaderPromise(new ViewReader(file, signal, closeFile), file.size, {
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw zipLimit();
    const entries: Entry[] = [];
    const names = new ZipNames();
    let bytes = 0;
    let metadataBytes = 0;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (entries.length >= MAX_ZIP_ENTRIES) throw zipLimit();
      metadataBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
      if (metadataBytes > 16 * 1024 ** 2) throw zipLimit();
      if (entry.generalPurposeBitFlag & 0x41 || ![0, 8].includes(entry.compressionMethod))
        throw new ApiError(400, "FILES_ARCHIVE_UNSUPPORTED", "Encrypted or unsupported ZIP entry");
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      const directory = entry.fileName.endsWith("/");
      if (mode && mode !== (directory ? 0o040000 : 0o100000))
        throw new ApiError(
          400,
          "FILES_ARCHIVE_UNSUPPORTED",
          "Links and special files are not supported",
        );
      const name = zipPath(entry.fileName);
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
      entries.push(entry);
    }
    return {
      zip,
      entries,
      names,
      close,
      listing: {
        root,
        path,
        bytes,
        entries: entries.map((entry) => ({
          path: zipPath(entry.fileName),
          type: entry.fileName.endsWith("/") ? "directory" : "file",
          size: entry.uncompressedSize,
        })),
      },
    };
  } catch (error) {
    await close();
    if (error instanceof ApiError || signal.aborted) throw error;
    const invalid = invalidZip();
    invalid.cause = error;
    throw invalid;
  }
}

/** Size checks alone do not detect corrupt ZIPs: validate CRC before an upload can commit. */
export function checkedZipStream(entry: Entry, progress: (bytes: number) => void): Transform {
  let bytes = 0;
  let checksum = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > entry.uncompressedSize || bytes > MAX_ZIP_BYTES) return callback(zipLimit());
      checksum = crc32(chunk, checksum);
      progress(chunk.length);
      callback(null, chunk);
    },
    flush(callback) {
      callback(bytes !== entry.uncompressedSize || checksum !== entry.crc32 ? invalidZip() : null);
    },
  });
}
