import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { DriveEntry } from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import type { FileView } from "../files/file-view.ts";
import type { TransferProgress, TransferTask } from "../transfers/transfer-service.ts";
import { localName, MAX_EXPORT_BYTES, type DriveService } from "./drive-service.ts";

/** "rapor.pdf" → "rapor (2).pdf": a name not yet taken in the folder. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ApiError(409, "CONFLICT", "No free name");
}

/** Passes bytes through while reporting them. */
function counter(progress: TransferProgress): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      progress.bytes(chunk.length);
      callback(null, chunk);
    },
  });
}

async function buffered(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      stream.destroy();
      throw new ApiError(413, "FILES_TOO_LARGE", "The exported file is too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const join = (...parts: string[]) => parts.filter(Boolean).join("/");

/**
 * Drive → an EveryOS folder. A folder is copied with its tree; names that are taken get a number,
 * nothing is overwritten. Google Docs files are exported in Office formats.
 */
export function driveDownloadTask(options: {
  drive: DriveService;
  files: () => FileView;
  userId: string;
  source: DriveEntry;
  destination: { root: string; path: string };
  from: string;
  to: string;
  withAccess: <T>(run: () => Promise<T>) => Promise<T>;
}): TransferTask {
  const { drive, userId, source, destination } = options;
  return {
    direction: "download",
    name: localName(source),
    from: options.from,
    to: options.to,
    bytesTotal: source.folder || source.exportAs ? null : source.sizeBytes,
    itemsTotal: source.folder ? null : 1,
    async run(progress, signal) {
      const files = options.files();
      const taken = async (path: string) =>
        new Set(
          (await options.withAccess(() => files.list(destination.root, path, true))).entries.map(
            (entry) => entry.name,
          ),
        );
      const copyFile = async (entry: DriveEntry, path: string, names: Set<string>) => {
        const download = await drive.download(userId, entry, signal);
        const name = freeName(download.name, names);
        names.add(name);
        // Exports have no length until they are read (Google caps them at 10 MB).
        const bytes =
          download.sizeBytes === null ? await buffered(download.stream, MAX_EXPORT_BYTES) : null;
        const length = bytes?.length ?? download.sizeBytes ?? 0;
        const body = (bytes ? Readable.from([bytes]) : download.stream).pipe(counter(progress));
        signal.addEventListener("abort", () => body.destroy(), { once: true });
        try {
          await options.withAccess(() =>
            files.upload(
              destination.root,
              path,
              name,
              Readable.toWeb(body) as WebReadableStream<Uint8Array>,
              length,
              false,
            ),
          );
        } finally {
          download.stream.destroy();
        }
        progress.item();
      };
      if (!source.folder) {
        await copyFile(source, destination.path, await taken(destination.path));
        return;
      }
      const items = await drive.walk(userId, source, signal);
      const fileItems = items.filter((item) => !item.entry.folder && item.entry.downloadable);
      progress.totals({
        items: fileItems.length,
        bytes: fileItems.some((item) => item.entry.exportAs)
          ? null
          : fileItems.reduce((sum, item) => sum + (item.entry.sizeBytes ?? 0), 0),
      });
      const top = freeName(localName(source), await taken(destination.path));
      await options.withAccess(() => files.mkdir(destination.root, destination.path, top));
      // Drive folders may share a name; each keeps its own local folder, found by its id.
      const folders = new Map<string, { path: string; names: Set<string> }>([
        [source.id, { path: join(destination.path, top), names: new Set() }],
      ]);
      for (const item of items) {
        if (signal.aborted) throw new ApiError(409, "CANCELLED", "Cancelled");
        const parent = folders.get(item.parent);
        if (!parent) continue;
        if (item.entry.folder) {
          const name = freeName(localName(item.entry), parent.names);
          parent.names.add(name);
          await options.withAccess(() => files.mkdir(destination.root, parent.path, name));
          folders.set(item.entry.id, { path: join(parent.path, name), names: new Set() });
        } else if (item.entry.downloadable) await copyFile(item.entry, parent.path, parent.names);
      }
    },
  };
}

/** An EveryOS file or folder → a Drive folder (Drive allows equal names; nothing is replaced). */
export function driveUploadTask(options: {
  drive: DriveService;
  files: () => FileView;
  userId: string;
  source: { root: string; path: string; name: string; type: "file" | "directory"; size: number };
  parent: string;
  from: string;
  to: string;
  withAccess: <T>(run: () => Promise<T>) => Promise<T>;
}): TransferTask {
  const { drive, userId, source } = options;
  return {
    direction: "upload",
    name: source.name,
    from: options.from,
    to: options.to,
    bytesTotal: source.type === "file" ? source.size : null,
    itemsTotal: source.type === "file" ? 1 : null,
    async run(progress, signal) {
      const files = options.files();
      const sendFile = async (path: string, name: string, parent: string) => {
        const opened = await options.withAccess(() => files.openFile(source.root, path));
        try {
          const stream = (
            opened.size
              ? opened.handle.createReadStream({ start: 0, end: opened.size - 1 })
              : Readable.from([])
          ).pipe(counter(progress));
          signal.addEventListener("abort", () => stream.destroy(), { once: true });
          await drive.upload(userId, parent, name, stream, opened.size, signal);
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
        progress.item();
      };
      if (source.type === "file") {
        await sendFile(source.path, source.name, options.parent);
        return;
      }
      // Count first, so the transfer shows its size and time left.
      const tree: Array<{ path: string; name: string; parent: string; folder: boolean }> = [];
      let bytes = 0;
      const walk = async (path: string, parent: string, depth: number): Promise<void> => {
        if (depth > 16) throw new ApiError(400, "VALIDATION_FAILED", "The folder is too deep");
        const listing = await options.withAccess(() => files.list(source.root, path, true));
        if (listing.truncated)
          throw new ApiError(400, "VALIDATION_FAILED", "The folder has too many items");
        for (const entry of listing.entries) {
          if (tree.length >= 10_000)
            throw new ApiError(400, "VALIDATION_FAILED", "The folder has too many items");
          if (entry.type === "directory") {
            tree.push({ path: join(path, entry.name), name: entry.name, parent, folder: true });
            await walk(join(path, entry.name), join(path, entry.name), depth + 1);
          } else if (entry.type === "file") {
            bytes += entry.size;
            tree.push({ path: join(path, entry.name), name: entry.name, parent, folder: false });
          }
        }
      };
      await walk(source.path, source.path, 0);
      progress.totals({ bytes, items: tree.filter((item) => !item.folder).length });
      const folders = new Map<string, string>();
      folders.set(source.path, (await drive.createFolder(userId, options.parent, source.name)).id);
      for (const item of tree) {
        if (signal.aborted) throw new ApiError(409, "CANCELLED", "Cancelled");
        const parent = folders.get(item.parent)!;
        if (item.folder)
          folders.set(item.path, (await drive.createFolder(userId, parent, item.name)).id);
        else await sendFile(item.path, item.name, parent);
      }
    },
  };
}
