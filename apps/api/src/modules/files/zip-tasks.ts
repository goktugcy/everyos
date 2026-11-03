import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAbortSignal, PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ZipWriter } from "@zip.js/zip.js/index-native.js";
import { ApiError } from "../../http/errors.ts";
import type { FileView } from "./file-view.ts";
import type { TransferProgress, TransferTask } from "../transfers/transfer-service.ts";
import {
  checkedZipStream,
  invalidZip,
  MAX_ZIP_BYTES,
  openZip,
  ZipNames,
  zipLimit,
  zipPath,
  zipReadError,
} from "./zip-reader.ts";

const pathJoin = (...parts: string[]) => parts.filter(Boolean).join("/");
const parent = (path: string) => path.split("/").slice(0, -1).join("/");
const base = (path: string) => path.split("/").at(-1)!;
const deadline = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);

interface Source {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modifiedAt: number;
}
interface ArchiveTaskOptions {
  root: string;
  path: string;
  name: string;
  password?: string;
  files: (signal?: AbortSignal) => FileView;
  withAccess: <T>(run: () => Promise<T>) => Promise<T>;
  from: string;
  to: string;
}

export async function vacant(files: FileView, root: string, directory: string, name: string) {
  const info = await files.properties(root, directory);
  if (info.type !== "directory")
    throw new ApiError(400, "VALIDATION_FAILED", "Choose a destination folder");
  try {
    await files.properties(root, pathJoin(directory, name));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") return;
    throw error;
  }
  throw new ApiError(409, "CONFLICT", "An item with this name already exists");
}

async function sources(files: FileView, root: string, paths: string[], signal: AbortSignal) {
  const result: Source[] = [];
  const names = new ZipNames();
  let bytes = 0;
  const visit = async (path: string, name: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 64) throw zipLimit();
    const info = await files.properties(root, path);
    if (info.type !== "file" && info.type !== "directory")
      throw new ApiError(
        400,
        "FILES_ARCHIVE_UNSUPPORTED",
        "Links and special files cannot be archived",
      );
    const directory = info.type === "directory";
    names.add(name, directory);
    bytes += directory ? 0 : info.size;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_ZIP_BYTES) throw zipLimit();
    result.push({
      path,
      name: zipPath(name),
      directory,
      size: directory ? 0 : info.size,
      modifiedAt: info.modifiedAt,
    });
    if (directory) {
      const listing = await files.list(root, path, true);
      if (listing.truncated) throw zipLimit();
      for (const item of listing.entries)
        await visit(pathJoin(path, item.name), pathJoin(name, item.name), depth + 1);
    }
  };
  const selected = [...new Set(paths.map((path) => path.split("/").filter(Boolean).join("/")))];
  for (const path of selected.filter(
    (path) => !selected.some((other) => other !== path && path.startsWith(other + "/")),
  ))
    await visit(path, base(path), 0);
  return { entries: result, bytes };
}

function byteCounter(progress: TransferProgress) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      progress.bytes(chunk.length);
      callback(null, chunk);
    },
  });
}

/** Compression uses private bounded scratch space; the existing upload commits the final ZIP. */
export function createZipTask(
  options: ArchiveTaskOptions & { paths: string[]; minFreeBytes: number },
): TransferTask {
  return {
    direction: "compress",
    name: options.name,
    from: options.from,
    to: options.to,
    run: (progress, cancelled) =>
      options.withAccess(async () => {
        const signal = deadline(cancelled);
        const files = options.files(signal);
        await vacant(files, options.root, options.path, options.name);
        const plan = await sources(files, options.root, options.paths, signal);
        progress.totals({ items: plan.entries.length + 1 });
        const temp = await mkdtemp(join(tmpdir(), "everyos-zip-"));
        const archive = join(temp, "archive.zip");
        const output = new PassThrough();
        const zip = new ZipWriter(Writable.toWeb(output), {
          useWebWorkers: false,
          level: 6,
          bufferedWrite: false,
        });
        const streams = new Set<Readable>();
        let size = 0;
        let checkAfter = 0;
        const space = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_ZIP_BYTES) return callback(zipLimit());
            checkAfter -= chunk.length;
            if (checkAfter > 0) return callback(null, chunk);
            checkAfter = 8 * 1024 ** 2;
            void statfs(temp).then(
              (disk) => {
                if (disk.bavail * disk.bsize < options.minFreeBytes + checkAfter)
                  callback(
                    new ApiError(507, "FILES_INSUFFICIENT_SPACE", "Not enough scratch space"),
                  );
                else callback(null, chunk);
              },
              (error: unknown) =>
                callback(
                  error instanceof Error ? error : new Error("Cannot inspect scratch space"),
                ),
            );
          },
        });
        const writing = pipeline(
          output,
          space,
          createWriteStream(archive, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        void writing.catch(() => undefined);
        try {
          for (const entry of plan.entries) {
            signal.throwIfAborted();
            const attributes = {
              lastModDate: new Date(entry.modifiedAt),
              externalFileAttributes: ((entry.directory ? 0o040750 : 0o100640) * 65536) >>> 0,
              versionMadeBy: 0x314,
              signal,
            };
            if (entry.directory) {
              await zip.add(entry.name + "/", undefined, { ...attributes, directory: true });
              progress.item();
              continue;
            }
            const source = Readable.from(
              (async function* () {
                const file = await files.openFile(options.root, entry.path);
                try {
                  if (file.size !== entry.size || file.modifiedAt !== entry.modifiedAt)
                    throw new ApiError(409, "CONFLICT", "A source file changed");
                  if (file.size)
                    for await (const chunk of addAbortSignal(
                      signal,
                      file.handle.createReadStream({
                        start: 0,
                        end: file.size - 1,
                        autoClose: false,
                      }),
                    )) {
                      progress.bytes((chunk as Buffer).length);
                      yield chunk;
                    }
                } finally {
                  await file.handle.close().catch(() => undefined);
                }
              })(),
            );
            streams.add(source);
            source.once("close", () => streams.delete(source));
            await zip.add(
              entry.name,
              { readable: Readable.toWeb(source), size: entry.size },
              {
                ...attributes,
                ...(options.password !== undefined
                  ? { password: options.password, encryptionStrength: 3 }
                  : {}),
              },
            );
            progress.item();
          }
          await zip.close();
          await writing;
          const info = await stat(archive);
          progress.totals({ bytes: plan.bytes + info.size });
          const file = await open(archive, "r");
          try {
            const raw = addAbortSignal(signal, file.createReadStream({ autoClose: false }));
            const stream = byteCounter(progress);
            const pumping = pipeline(raw, stream, { signal });
            void pumping.catch(() => undefined);
            try {
              await files.upload(
                options.root,
                options.path,
                options.name,
                Readable.toWeb(stream) as WebReadableStream<Uint8Array>,
                info.size,
                false,
              );
              await pumping;
              progress.item();
            } finally {
              raw.destroy();
              stream.destroy();
              await pumping.catch(() => undefined);
            }
          } finally {
            await file.close();
          }
        } finally {
          output.destroy();
          for (const stream of streams) stream.destroy();
          await writing.catch(() => undefined);
          await rm(temp, { recursive: true, force: true });
        }
      }),
  };
}

/** Decode only into a new private staging tree, then publish it using normal scoped file operations. */
export function extractZipTask(options: ArchiveTaskOptions): TransferTask {
  return {
    direction: "extract",
    name: base(options.path),
    from: options.from,
    to: options.to,
    run: (progress, cancelled) =>
      options.withAccess(async () => {
        const signal = deadline(cancelled);
        const files = options.files(signal);
        const directory = parent(options.path);
        await vacant(files, options.root, directory, options.name);
        const archive = await openZip(files, options.root, options.path, signal);
        const stagingName = `.everyos-archive-${randomUUID()}`;
        const staging = pathJoin(directory, stagingName);
        let staged = false;
        try {
          if (archive.listing.encrypted && options.password === undefined)
            throw new ApiError(
              400,
              "FILES_ARCHIVE_PASSWORD_REQUIRED",
              "An archive password is required",
            );
          progress.totals({ bytes: archive.listing.bytes, items: archive.names.entries.size });
          await files.mkdir(options.root, directory, stagingName);
          staged = true;
          const directories = [...archive.names.entries.values()]
            .filter((entry) => entry.directory)
            .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
          for (const entry of directories) {
            signal.throwIfAborted();
            await files.mkdir(
              options.root,
              pathJoin(staging, parent(entry.path)),
              base(entry.path),
            );
            progress.item();
          }
          for (const entry of archive.entries) {
            if (entry.directory) continue;
            signal.throwIfAborted();
            const name = zipPath(entry.filename);
            const checked = checkedZipStream(entry, (bytes) => progress.bytes(bytes));
            const decoding = (async () => {
              try {
                await entry.getData(Writable.toWeb(checked), {
                  signal,
                  checkSignature: true,
                  preventClose: true,
                  ...(options.password !== undefined ? { password: options.password } : {}),
                });
                // Only validated plaintext can end the upload and commit into our private staging tree.
                checked.end();
              } catch (error) {
                const failure = signal.aborted ? error : zipReadError(error, entry.encrypted);
                checked.destroy(failure instanceof Error ? failure : invalidZip());
                throw failure;
              }
            })();
            void decoding.catch(() => undefined);
            try {
              await files.upload(
                options.root,
                pathJoin(staging, parent(name)),
                base(name),
                Readable.toWeb(checked) as WebReadableStream<Uint8Array>,
                entry.uncompressedSize,
                false,
              );
              await decoding;
            } finally {
              checked.destroy();
              await decoding.catch(() => undefined);
            }
            progress.item();
          }
          signal.throwIfAborted();
          await files.rename(options.root, staging, options.name);
          staged = false;
        } finally {
          await archive.close();
          // This is only our fresh staging directory; cleanup never removes an existing destination.
          if (staged)
            await options
              .files()
              .discardArchiveStage(options.root, staging)
              .catch(() => undefined);
        }
      }),
  };
}
