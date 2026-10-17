import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Logger } from "@everyos/logger";
import type { Services } from "../../services.ts";
import { callAgentAs, type UserActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import type { FileService } from "./file-service.ts";

/** Who uses a file view, and what their Linux-side requests carry. */
export interface FileViewIdentity {
  actor: UserActor;
  locale: "tr" | "en";
  systemRoots: boolean;
  signal?: AbortSignal | undefined;
  logger: Logger;
}

/** EveryOS personal storage stays in the API; every host location runs as the linked Linux UID. */
export class AccountFileView {
  readonly services: Services;
  readonly personal: FileService;
  readonly identity: FileViewIdentity;
  constructor(services: Services, personal: FileService, identity: FileViewIdentity) {
    this.services = services;
    this.personal = personal;
    this.identity = identity;
  }

  #params() {
    return { locale: this.identity.locale, systemRoots: this.identity.systemRoots };
  }
  #call = <N extends Parameters<typeof callAgentAs>[2]>(
    op: N,
    params: Parameters<typeof callAgentAs<N>>[3],
  ) =>
    callAgentAs(this.services, this.identity.actor, op, params, {
      signal: this.identity.signal,
      logger: this.identity.logger,
    }).catch((error: unknown) => {
      // A full location is the person's to resolve, not an agent failure.
      if (error instanceof ApiError && error.message === "FILES_INSUFFICIENT_SPACE")
        throw new ApiError(507, "FILES_INSUFFICIENT_SPACE", "Not enough free space");
      throw error;
    });

  async roots(canWrite: boolean) {
    const personal = (await this.personal.roots(canWrite)).filter((r) => r.id === "home");
    const status = await this.#call("identity.status", {});
    return status.account
      ? personal.concat(await this.#call("files.roots", this.#params()))
      : personal;
  }
  list(root: string, path: string, hidden: boolean) {
    return root === "home"
      ? this.personal.list(root, path, hidden)
      : this.#call("files.list", {
          ...this.#params(),
          root,
          path,
          hidden: hidden ? "true" : "false",
        });
  }
  properties(root: string, path: string) {
    return root === "home"
      ? this.personal.properties(root, path)
      : this.#call("files.properties", { ...this.#params(), root, path });
  }
  search(root: string, path: string, q: string) {
    return root === "home"
      ? this.personal.search(root, path, q)
      : this.#call("files.search", { ...this.#params(), root, path, q });
  }
  readText(root: string, path: string) {
    return root === "home"
      ? this.personal.readText(root, path)
      : this.#call("files.text", { ...this.#params(), root, path });
  }
  writeText(root: string, path: string, content: string, etag: string | null) {
    return root === "home"
      ? this.personal.writeText(root, path, content, etag)
      : this.#call("files.text.write", { ...this.#params(), root, path, content, etag });
  }
  mkdir(root: string, path: string, name: string) {
    return root === "home"
      ? this.personal.mkdir(root, path, name)
      : this.#call("files.mkdir", { ...this.#params(), root, path, name });
  }
  rename(root: string, path: string, name: string) {
    return root === "home"
      ? this.personal.rename(root, path, name)
      : this.#call("files.rename", { ...this.#params(), root, path, name });
  }
  remove(root: string, paths: string[]) {
    return root === "home"
      ? this.personal.remove(root, paths)
      : this.#call("files.delete", { ...this.#params(), root, paths, confirm: true });
  }
  async trash() {
    const personal = await this.personal.trash();
    const status = await this.#call("identity.status", {});
    if (!status.account) return personal;
    const host = await this.#call("files.trash", this.#params());
    return {
      entries: personal.entries.filter((e) => e.root === "home").concat(host.entries),
      truncated: personal.truncated || host.truncated,
    };
  }
  restoreTrash(root: string, ids: string[]) {
    return root === "home"
      ? this.personal.restoreTrash(root, ids)
      : this.#call("files.trash.restore", { ...this.#params(), root, ids });
  }
  deleteTrash(root: string, ids: string[]) {
    return root === "home"
      ? this.personal.deleteTrash(root, ids)
      : this.#call("files.trash.delete", { ...this.#params(), root, ids, confirm: true });
  }

  async openFile(root: string, path: string) {
    if (root === "home") return this.personal.openFile(root, path);
    const opened = await this.#call("files.download.open", { ...this.#params(), root, path });
    const close = async () => {
      await this.#call("files.download.close", {
        ...this.#params(),
        transferId: opened.transferId,
      });
    };
    const read = async function* (view: AccountFileView, start: number, end: number) {
      let offset = start;
      try {
        while (offset <= end) {
          const { data } = await view.#call("files.download.read", {
            ...view.#params(),
            transferId: opened.transferId,
            offset,
            length: Math.min(48 * 1024, end - offset + 1),
          });
          const chunk = Buffer.from(data, "base64");
          if (!chunk.length) break;
          offset += chunk.length;
          yield chunk;
        }
      } finally {
        await close().catch(() => undefined);
      }
    };
    return {
      ...opened,
      handle: {
        close,
        createReadStream: ({ start, end }: { start: number; end: number; autoClose?: boolean }) =>
          Readable.from(read(this, start, end)),
      },
    };
  }

  async upload(
    root: string,
    path: string,
    name: string,
    body: WebReadableStream<Uint8Array>,
    length: number,
    overwrite: boolean,
  ) {
    if (root === "home") return this.personal.upload(root, path, name, body, length, overwrite);
    const opened = await this.#call("files.upload.open", {
      ...this.#params(),
      root,
      path,
      name,
      length,
      overwrite,
    });
    let commit = false;
    try {
      for await (const data of Readable.fromWeb(body)) {
        const chunk = Buffer.from(data as Uint8Array);
        for (let offset = 0; offset < chunk.length; offset += 48 * 1024)
          await this.#call("files.upload.write", {
            ...this.#params(),
            transferId: opened.transferId,
            data: chunk.subarray(offset, offset + 48 * 1024).toString("base64"),
          });
      }
      await this.#call("files.upload.close", {
        ...this.#params(),
        transferId: opened.transferId,
        commit: true,
      });
      commit = true;
    } finally {
      if (!commit)
        await this.#call("files.upload.close", {
          ...this.#params(),
          transferId: opened.transferId,
          commit: false,
        }).catch(() => undefined);
    }
  }

  async copy(
    root: string,
    paths: string[],
    destination: { root: string; path: string },
    name?: string,
  ) {
    if (root === "home" && destination.root === "home")
      return this.personal.copy(root, paths, destination, name);
    if (root !== "home" && destination.root !== "home")
      return this.#call("files.copy", {
        ...this.#params(),
        root,
        paths,
        destination,
        ...(name !== undefined ? { name } : {}),
      });
    if (name !== undefined && paths.length !== 1)
      throw new ApiError(400, "VALIDATION_FAILED", "A custom name requires one source");
    // Streaming between managed personal storage and a Linux location preserves both boundaries.
    let count = 0;
    const created: string[] = [];
    const copy = async (
      path: string,
      parent: string,
      targetName: string,
      depth: number,
    ): Promise<void> => {
      if (++count > 10_000 || depth > 16)
        throw new ApiError(400, "VALIDATION_FAILED", "Copy is too large");
      const item = await this.properties(root, path);
      if (!path || (item.type !== "file" && item.type !== "directory"))
        throw new ApiError(
          400,
          "VALIDATION_FAILED",
          "Only regular files and folders can cross storage boundaries",
        );
      if (item.type === "directory") {
        const listing = await this.list(root, path, true);
        if (listing.truncated) throw new ApiError(400, "VALIDATION_FAILED", "Copy is too large");
        await this.mkdir(destination.root, parent, targetName);
        if (depth === 0) created.push([parent, targetName].filter(Boolean).join("/"));
        for (const entry of listing.entries)
          await copy(
            `${path}/${entry.name}`,
            [parent, targetName].filter(Boolean).join("/"),
            entry.name,
            depth + 1,
          );
      } else {
        const opened = await this.openFile(root, path);
        try {
          const stream = opened.size
            ? opened.handle.createReadStream({ start: 0, end: opened.size - 1 })
            : Readable.from([]);
          await this.upload(
            destination.root,
            parent,
            targetName,
            Readable.toWeb(stream) as WebReadableStream<Uint8Array>,
            opened.size,
            false,
          );
          if (depth === 0) created.push([parent, targetName].filter(Boolean).join("/"));
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
      }
    };
    try {
      for (const path of paths)
        await copy(path, destination.path, name ?? path.split("/").at(-1)!, 0);
    } catch (error) {
      // Move completed top-level outputs to trash, preserving their recovery information.
      for (const path of created.reverse())
        await this.remove(destination.root, [path]).catch(() => undefined);
      throw error;
    }
  }

  async move(root: string, paths: string[], destination: { root: string; path: string }) {
    if (root === "home" && destination.root === "home")
      return this.personal.move(root, paths, destination);
    if (root !== "home" && destination.root !== "home")
      return this.#call("files.move", { ...this.#params(), root, paths, destination });
    if (root === "home") {
      const folders = (await this.personal.roots(true)).find((r) => r.id === "home")?.folders;
      if (
        paths.some(
          (p) => !p || Object.values(folders ?? {}).includes(p) || p === ".otuken-folders.json",
        )
      )
        throw new ApiError(403, "FILES_PROTECTED", "Standard folders cannot be moved");
    }
    await this.copy(root, paths, destination);
    await this.remove(root, paths);
  }
}
