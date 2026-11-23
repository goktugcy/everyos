import { Readable, addAbortSignal } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Logger } from "@everyos/logger";
import type { FileProperties, FileRootView, NetworkConnection } from "@everyos/shared";
import { ARCHIVE_STAGING_NAME, isNetworkRoot as networkRoot } from "@everyos/shared";
import type { Services } from "../../services.ts";
import { ApiError } from "../../http/errors.ts";
import { callAgentAs } from "../../http/agent.ts";
import { fileViewFor, type FileUser } from "./file-view.ts";
import type { FileService } from "./file-service.ts";
import type { AccountFileView } from "./account-file-view.ts";
import type { TransferProgress, TransferTask } from "../transfers/transfer-service.ts";

const join = (...s: string[]) => s.filter(Boolean).join("/");
type Base = FileService | AccountFileView;
export class NetworkFileView {
  readonly services: Services;
  readonly base: Base;
  readonly who: FileUser;
  readonly options: { signal?: AbortSignal | undefined; logger: Logger };
  constructor(services: Services, base: Base, who: FileUser, options: NetworkFileView["options"]) {
    this.services = services;
    this.base = base;
    this.who = who;
    this.options = options;
  }
  hasLinuxAccount() {
    return "hasLinuxAccount" in this.base ? this.base.hasLinuxAccount() : Promise.resolve(true);
  }
  async roots(canWrite: boolean): Promise<FileRootView[]> {
    const original = (await this.base.roots(canWrite)).filter((r) => r.kind !== "network");
    const connections = this.services.sharing.connections(this.who.actor);
    if (!connections.length) return original;
    const host = connections.some((c) => c.protocol !== "sftp")
      ? await callAgentAs(this.services, this.who.actor, "sharing.status", {}, this.options).catch(
          () => null,
        )
      : null;
    return original.concat(
      connections.map((c) => ({
        id: c.root,
        name: c.name,
        kind: "network" as const,
        networkProtocol: c.protocol,
        readOnly: c.readOnly || !canWrite,
        available:
          c.enabled &&
          (c.protocol === "sftp" ||
            c.automount ||
            Boolean(host?.mounts.some((m) => m.id === c.id && m.mounted))),
      })),
    );
  }
  #connection(root: string): NetworkConnection {
    const c = this.services.sharing.connections(this.who.actor).find((v) => v.root === root);
    if (!c) throw new ApiError(404, "NOT_FOUND", "Network folder not found");
    return c;
  }
  async #files(root: string, write = false) {
    if (!networkRoot(root)) return this.base;
    const c = this.#connection(root);
    if (write && (!this.who.permissions.has("files:write") || c.readOnly))
      throw new ApiError(403, "FILES_READ_ONLY", "Read-only network folder");
    await this.services.sharing.ensure(c, this.who.actor, this.options.signal);
    return c.protocol === "sftp"
      ? this.services.sharing.sftp(c, this.who.actor, this.options.signal)
      : this.base;
  }
  async list(root: string, path: string, hidden: boolean) {
    return (await this.#files(root)).list(root, path, hidden);
  }
  async properties(root: string, path: string) {
    return (await this.#files(root)).properties(root, path);
  }
  async search(root: string, path: string, q: string) {
    return (await this.#files(root)).search(root, path, q);
  }
  async readText(root: string, path: string) {
    return (await this.#files(root)).readText(root, path);
  }
  async writeText(root: string, path: string, content: string, etag: string | null) {
    return (await this.#files(root, true)).writeText(root, path, content, etag);
  }
  async openFile(root: string, path: string) {
    return (await this.#files(root)).openFile(root, path);
  }
  async mkdir(root: string, path: string, name: string) {
    return (await this.#files(root, true)).mkdir(root, path, name);
  }
  async rename(root: string, path: string, name: string) {
    return (await this.#files(root, true)).rename(root, path, name);
  }
  async remove(root: string, paths: string[]) {
    return (await this.#files(root, true)).remove(root, paths);
  }
  async upload(
    root: string,
    path: string,
    name: string,
    body: WebReadableStream<Uint8Array>,
    length: number,
    overwrite: boolean,
  ) {
    return (await this.#files(root, true)).upload(root, path, name, body, length, overwrite);
  }
  async trash() {
    const listing = await this.base.trash();
    if (!("networkTrash" in this.base)) return listing;
    // Do not activate disconnected mounts just to poll the global trash icon.
    const deadline = AbortSignal.timeout(12000);
    const signal = this.options.signal
      ? AbortSignal.any([deadline, this.options.signal])
      : deadline;
    const host = await callAgentAs(
      this.services,
      this.who.actor,
      "sharing.status",
      {},
      { ...this.options, signal },
    ).catch(() => null);
    if (!host) {
      listing.truncated = true;
      return listing;
    }
    for (const c of this.services.sharing
      .connections(this.who.actor)
      .filter(
        (c) =>
          c.enabled && c.protocol !== "sftp" && host.mounts.some((m) => m.id === c.id && m.mounted),
      )) {
      if (signal.aborted) {
        listing.truncated = true;
        break;
      }
      try {
        await this.services.sharing.ensure(c, this.who.actor, signal);
        const remote = await this.base.networkTrash(c.root, signal);
        listing.entries.push(...remote.entries);
        listing.truncated ||= remote.truncated;
      } catch {
        listing.truncated = true;
      }
    }
    return listing;
  }
  restoreTrash(root: string, ids: string[]) {
    return this.base.restoreTrash(root, ids);
  }
  deleteTrash(root: string, ids: string[]) {
    return this.base.deleteTrash(root, ids);
  }
  discardShelf(paths: readonly string[]) {
    return this.base.discardShelf(paths);
  }
  tidyShelf(listed: ReadonlySet<string>, now: number) {
    return this.base.tidyShelf(listed, now);
  }
  async discardArchiveStage(root: string, path: string) {
    if (networkRoot(root) && this.#connection(root).protocol === "sftp") {
      if (!ARCHIVE_STAGING_NAME.test(path.split("/").at(-1) ?? ""))
        throw new ApiError(403, "FILES_PROTECTED", "Only archive staging may be discarded");
      await this.remove(root, [path]);
      return;
    }
    return this.base.discardArchiveStage(root, path);
  }
  async copy(
    root: string,
    paths: string[],
    destination: { root: string; path: string },
    name?: string,
  ) {
    if (!networkRoot(root) && !networkRoot(destination.root))
      return this.base.copy(root, paths, destination, name);
    await this.#copy(root, paths, destination, name, null, false);
  }
  async move(root: string, paths: string[], destination: { root: string; path: string }) {
    if (!networkRoot(root) && !networkRoot(destination.root))
      return this.base.move(root, paths, destination);
    await this.#copy(root, paths, destination, undefined, null, true);
  }
  task(
    root: string,
    paths: string[],
    destination: { root: string; path: string },
    move: boolean,
    name?: string,
  ): TransferTask {
    if (
      this.services.transfers
        .list(this.who.user.id)
        .filter((j) => j.state === "queued" || j.state === "running").length >= 16
    )
      throw new ApiError(429, "RATE_LIMITED", "Transfer queue is full");
    return {
      direction: networkRoot(destination.root) ? "upload" : "download",
      name: name ?? paths[0]?.split("/").at(-1) ?? "",
      from: root,
      to: destination.root,
      run: async (progress, signal) =>
        this.services.files.withAccess(this.who.user.id, async () => {
          const user = this.services.users.findById(this.who.user.id);
          if (!user || user.disabled || !this.who.permissions.has("files:write"))
            throw new ApiError(403, "FORBIDDEN", "File access revoked");
          const { ROLE_PERMISSIONS } = await import("@everyos/shared");
          if (!ROLE_PERMISSIONS[user.role].has("files:write"))
            throw new ApiError(403, "FORBIDDEN", "File access revoked");
          const fresh = fileViewFor(
            this.services,
            {
              ...this.who,
              actor: { ...this.who.actor, role: user.role },
              permissions: ROLE_PERMISSIONS[user.role],
            },
            { ...this.options, signal },
          );
          await fresh.#copy(root, paths, destination, name, progress, move, signal);
        }),
    };
  }
  async #copy(
    root: string,
    paths: string[],
    destination: { root: string; path: string },
    name: string | undefined,
    progress: TransferProgress | null,
    move: boolean,
    signal?: AbortSignal,
  ) {
    if (name !== undefined && paths.length !== 1)
      throw new ApiError(400, "VALIDATION_FAILED", "A custom name needs one source");
    if (
      root === destination.root &&
      paths.some((p) => destination.path === p || destination.path.startsWith(p + "/"))
    )
      throw new ApiError(400, "VALIDATION_FAILED", "Cannot copy a folder into itself");
    const plan: Array<{
      source: string;
      parent: string;
      name: string;
      info: FileProperties;
      top: boolean;
    }> = [];
    let bytes = 0;
    const scan = async (path: string, parent: string, target: string, depth: number) => {
      signal?.throwIfAborted();
      if (!path || depth > 16 || plan.length >= 10000)
        throw new ApiError(400, "VALIDATION_FAILED", "Transfer is too large");
      const info = await this.properties(root, path);
      if (info.type !== "file" && info.type !== "directory")
        throw new ApiError(
          400,
          "VALIDATION_FAILED",
          "Only regular files and folders can cross network boundaries",
        );
      if (move && root === "home") {
        const folders = (await this.base.roots(true)).find((r) => r.id === "home")?.folders;
        if (Object.values(folders ?? {}).includes(path) || path === ".otuken-folders.json")
          throw new ApiError(403, "FILES_PROTECTED", "Standard folders are protected");
      }
      plan.push({ source: path, parent, name: target, info, top: depth === 0 });
      if (info.type === "file") bytes += info.size;
      else {
        const listing = await this.list(root, path, true);
        if (listing.truncated)
          throw new ApiError(400, "VALIDATION_FAILED", "Transfer is too large");
        for (const item of listing.entries)
          await scan(join(path, item.name), join(parent, target), item.name, depth + 1);
      }
    };
    for (const path of paths)
      await scan(path, destination.path, name ?? path.split("/").at(-1)!, 0);
    progress?.totals({ bytes, items: plan.filter((p) => p.info.type === "file").length });
    for (const item of plan) {
      signal?.throwIfAborted();
      const user = this.services.users.findById(this.who.user.id);
      if (
        !user ||
        user.disabled ||
        user.role !== this.who.actor.role ||
        !roleHasFileWrite(user.role)
      )
        throw new ApiError(403, "FORBIDDEN", "File access revoked");
      if (item.info.type === "directory")
        await this.mkdir(destination.root, item.parent, item.name);
      else {
        const file = await this.openFile(root, item.source);
        try {
          const input = file.size
            ? file.handle.createReadStream({ start: 0, end: file.size - 1 })
            : Readable.from([]);
          const validate = () => {
            const current = this.services.users.findById(this.who.user.id);
            if (!current || current.disabled || current.role !== this.who.actor.role)
              throw new ApiError(403, "FORBIDDEN", "File access revoked");
          };
          const stream = Readable.from(
            (async function* () {
              for await (const data of input) {
                validate();
                const chunk = Buffer.from(data as Uint8Array);
                progress?.bytes(chunk.length);
                yield chunk;
              }
            })(),
          );
          if (signal) {
            addAbortSignal(signal, input);
            addAbortSignal(signal, stream);
          }
          const abort = () => {
            input.destroy(new ApiError(409, "CANCELLED", "Cancelled"));
            stream.destroy();
          };
          signal?.addEventListener("abort", abort, { once: true });
          try {
            await this.upload(
              destination.root,
              item.parent,
              item.name,
              Readable.toWeb(stream) as WebReadableStream<Uint8Array>,
              file.size,
              false,
            );
            progress?.item();
          } finally {
            signal?.removeEventListener("abort", abort);
            input.destroy();
            stream.destroy();
          }
        } finally {
          await file.handle.close().catch(() => undefined);
        }
      }
    }
    if (move) {
      // Never delete a source that changed while the streamed copy was running.
      for (const item of plan) {
        const current = await this.properties(root, item.source);
        if (
          current.type !== item.info.type ||
          current.modifiedAt !== item.info.modifiedAt ||
          (current.type === "file" && current.size !== item.info.size)
        )
          throw new ApiError(409, "CONFLICT", "Source changed; copied data retained");
      }
      await this.remove(root, paths);
    }
  }
}
import { roleHasPermission } from "@everyos/shared";
const roleHasFileWrite = (role: Parameters<typeof roleHasPermission>[0]) =>
  roleHasPermission(role, "files:write");
