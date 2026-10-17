import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { PassThrough, Readable } from "node:stream";
import { once } from "node:events";
import { OperationError, type OperationHandlers } from "@everyos/agent-protocol";
import { diskRootId, roleHasPermission } from "@everyos/shared";
import type { Logger } from "@everyos/logger";
import { readMountedDisks } from "@everyos/system";
import {
  FileService,
  SYSTEM_ROOTS,
  type FileRootConfig,
} from "../../api/src/modules/files/file-service.ts";
import { ApiError } from "../../api/src/http/errors.ts";

export function accountFiles(options: {
  roots: FileRootConfig[];
  /** Disks mounted from Settings › Disks appear as Files locations. */
  disksRoot: string;
  home: string;
  userId: string;
  logger: Logger;
  maxUploadBytes: number;
  minFreeBytes: number;
}): Pick<OperationHandlers, Extract<keyof OperationHandlers, `files.${string}`>> {
  const downloads = new Map<string, { handle: FileHandle; at: number }>();
  const uploads = new Map<string, { stream: PassThrough; done: Promise<void>; at: number }>();
  const limit = () => {
    if (downloads.size + uploads.size >= 16)
      throw new OperationError("busy", "Too many file transfers");
  };
  const timer = setInterval(() => {
    for (const [id, item] of downloads)
      if (Date.now() - item.at > 120_000) {
        downloads.delete(id);
        void item.handle.close();
      }
    for (const [id, item] of uploads)
      if (Date.now() - item.at > 120_000) {
        uploads.delete(id);
        item.stream.destroy(new Error("Transfer expired"));
      }
  }, 15_000);
  timer.unref();
  const service = (
    params: { locale: "tr" | "en"; systemRoots: boolean },
    actor: Parameters<OperationHandlers["files.roots"]>[1]["actor"],
  ) => {
    const roots = [
      ...options.roots,
      {
        id: "linux-home",
        name: options.home,
        path: options.home,
        readOnly: false,
        kind: "location" as const,
      },
      ...readMountedDisks({ mountRoot: options.disksRoot }).map((disk) => ({
        id: diskRootId(disk.uuid),
        name: disk.label ?? disk.uuid,
        path: disk.path,
        readOnly: disk.readOnly,
        kind: "disk" as const,
      })),
    ];
    if (
      params.systemRoots &&
      actor.kind === "user" &&
      roleHasPermission(actor.role, "system:manage")
    )
      roots.push(
        ...SYSTEM_ROOTS.map((root) => ({
          ...root,
          name: root.path,
          readOnly: true,
          kind: "system" as const,
        })),
      );
    return new FileService({
      roots,
      maxUploadBytes: options.maxUploadBytes,
      minFreeBytes: options.minFreeBytes,
      logger: options.logger,
      trashOwner: options.userId,
    });
  };
  const safe = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) throw new OperationError("policy_denied", "LINUX_FILE_DENIED");
        if (error.status === 404) throw new OperationError("not_found", "File not found");
        if (error.status === 409 || error.status === 507)
          throw new OperationError("conflict", error.code);
        throw new OperationError("failed", error.code);
      }
      throw error;
    }
  };
  return {
    "files.roots": (p, { actor }) =>
      safe(() =>
        service(p, actor).roots(
          actor.kind === "user" && roleHasPermission(actor.role, "files:write"),
        ),
      ),
    "files.list": (p, { actor }) =>
      safe(() => service(p, actor).list(p.root, p.path, p.hidden === "true")),
    "files.properties": (p, { actor }) => safe(() => service(p, actor).properties(p.root, p.path)),
    "files.search": (p, { actor }) => safe(() => service(p, actor).search(p.root, p.path, p.q)),
    "files.text": (p, { actor }) => safe(() => service(p, actor).readText(p.root, p.path)),
    "files.text.write": (p, { actor }) =>
      safe(() => service(p, actor).writeText(p.root, p.path, p.content, p.etag)),
    "files.mkdir": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).mkdir(p.root, p.path, p.name);
        return null;
      }),
    "files.rename": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).rename(p.root, p.path, p.name);
        return null;
      }),
    "files.copy": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).copy(p.root, p.paths, p.destination, p.name);
        return null;
      }),
    "files.move": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).move(p.root, p.paths, p.destination);
        return null;
      }),
    "files.delete": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).remove(p.root, p.paths);
        return null;
      }),
    "files.trash": (p, { actor }) => safe(() => service(p, actor).trash()),
    "files.trash.restore": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).restoreTrash(p.root, p.ids);
        return null;
      }),
    "files.trash.delete": (p, { actor }) =>
      safe(async () => {
        await service(p, actor).deleteTrash(p.root, p.ids);
        return null;
      }),
    "files.download.open": (p, { actor }) =>
      safe(async () => {
        limit();
        const file = await service(p, actor).openFile(p.root, p.path);
        const transferId = randomUUID();
        downloads.set(transferId, { handle: file.handle, at: Date.now() });
        return { transferId, size: file.size, modifiedAt: file.modifiedAt, name: file.name };
      }),
    "files.download.read": (p) =>
      safe(async () => {
        const item = downloads.get(p.transferId);
        if (!item) throw new OperationError("not_found", "Transfer not found");
        item.at = Date.now();
        const data = Buffer.alloc(p.length);
        const { bytesRead } = await item.handle.read(data, 0, p.length, p.offset);
        return { data: data.subarray(0, bytesRead).toString("base64") };
      }),
    "files.download.close": async (p) => {
      const item = downloads.get(p.transferId);
      downloads.delete(p.transferId);
      await item?.handle.close();
      return null;
    },
    "files.upload.open": (p, { actor }) => {
      limit();
      const transferId = randomUUID();
      const stream = new PassThrough({ highWaterMark: 48 * 1024 });
      const done = safe(() =>
        service(p, actor).upload(
          p.root,
          p.path,
          p.name,
          Readable.toWeb(stream) as WebReadableStream<Uint8Array>,
          p.length,
          p.overwrite,
        ),
      );
      // Preserve the failure for commit, and unblock producers if the destination is denied.
      done.catch(() => stream.destroy());
      uploads.set(transferId, { stream, done, at: Date.now() });
      return { transferId };
    },
    "files.upload.write": async (p) => {
      const item = uploads.get(p.transferId);
      if (!item) throw new OperationError("not_found", "Transfer not found");
      item.at = Date.now();
      if (item.stream.destroyed) {
        await item.done;
        throw new OperationError("failed", "Transfer closed");
      }
      if (!item.stream.write(Buffer.from(p.data, "base64")))
        await Promise.race([once(item.stream, "drain"), item.done]);
      return null;
    },
    "files.upload.close": async (p) => {
      const item = uploads.get(p.transferId);
      uploads.delete(p.transferId);
      if (!item) return null;
      if (p.commit) {
        item.stream.end();
        await item.done;
      } else {
        item.stream.destroy(new Error("Transfer canceled"));
        await item.done.catch(() => undefined);
      }
      return null;
    },
  };
}
