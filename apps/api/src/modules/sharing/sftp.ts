import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { isIP, BlockList } from "node:net";
import { addressAllowed } from "@everyos/catalogs";
import { posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type {
  NetworkConnection,
  FileEntry,
  FileListing,
  FileProperties,
  FileSearchResult,
  TextFile,
} from "@everyos/shared";
import { MAX_TEXT_FILE_BYTES } from "@everyos/shared";
import { RelativePathSchema, FileNameSchema } from "@everyos/shared/schemas";
import { ApiError } from "../../http/errors.ts";

export interface NetworkCredentials {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  domain?: string;
}
export interface SftpLease {
  client: Client;
  sftp: SFTPWrapper;
  release(): void;
}
const unavailable = () =>
  new ApiError(503, "SHARING_UNREACHABLE", "Remote file server unavailable");
const digest = (key: Buffer) =>
  "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
export function unsafeNetworkAddress(address: string) {
  return (
    !addressAllowed(address, true) || loopback.check(address, isIP(address) === 4 ? "ipv4" : "ipv6")
  );
}
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
export async function resolveNetworkHost(host: string, allowLoopback = false) {
  let timer: NodeJS.Timeout | undefined;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          lookup(host, { all: true }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(unavailable()), 3000);
          }),
        ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (
    !addresses.length ||
    addresses.length > 16 ||
    addresses.some(
      (v) =>
        !addressAllowed(v.address, true) || (!allowLoopback && unsafeNetworkAddress(v.address)),
    )
  )
    throw new ApiError(403, "SHARING_NETWORK_DENIED", "This network destination is not permitted");
  return addresses[0]!.address;
}
function timed<T>(
  run: (callback: (error: Error | undefined | null, value: T) => void) => void,
  signal?: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(unavailable()), 12000);
    const abort = () => finish(new ApiError(409, "CANCELLED", "Cancelled"));
    function finish(error?: Error | null, value?: T) {
      if (settled) {
        if (value !== undefined) late?.(value);
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(sftpError(error));
      else resolve(value as T);
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      run((error, value) => finish(error, value));
    } catch (error) {
      finish(error as Error);
    }
  });
}
export function sftpError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new ApiError(409, "CANCELLED", "Cancelled");
  const code = (error as { code?: unknown }).code;
  if (code === 2) return new ApiError(404, "NOT_FOUND", "File not found");
  if (code === 3) return new ApiError(403, "FORBIDDEN", "Remote permission denied");
  return unavailable();
}
export class SftpPool {
  readonly allowLoopback: boolean;
  #pending = new Map<string, { owner: string; promise: Promise<string>; cancelled: boolean }>();
  #probing = 0;
  #entries = new Map<
    string,
    {
      client: Client;
      owner: string;
      ready: Promise<Client>;
      connected: boolean;
      active: number;
      timer: NodeJS.Timeout | null;
    }
  >();
  constructor(options: { allowLoopback?: boolean } = {}) {
    this.allowLoopback = options.allowLoopback ?? false;
  }
  isConnected(id: string) {
    return [...this.#entries].some(([key, entry]) => key.startsWith(id + ":") && entry.connected);
  }
  close(id?: string) {
    for (const [key, pending] of this.#pending)
      if (!id || key.startsWith(id + ":")) {
        pending.cancelled = true;
        this.#pending.delete(key);
      }
    for (const [key, entry] of this.#entries)
      if (!id || key.startsWith(id + ":")) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.client.destroy();
        this.#entries.delete(key);
      }
  }
  async probe(host: string, port: number): Promise<string> {
    if (this.#probing >= 4) throw new ApiError(429, "RATE_LIMITED", "Too many host key probes");
    this.#probing++;
    try {
      const address = await resolveNetworkHost(host, this.allowLoopback);
      const client = new Client();
      return await new Promise((resolve, reject) => {
        let found = false;
        const timer = setTimeout(() => {
          client.destroy();
          reject(unavailable());
        }, 10000);
        client.on("error", () => {
          clearTimeout(timer);
          if (!found) reject(unavailable());
        });
        client.connect({
          host: address,
          port,
          username: "everyos-host-key-probe",
          readyTimeout: 8000,
          hostVerifier: (key: Buffer) => {
            found = true;
            clearTimeout(timer);
            resolve(digest(key));
            queueMicrotask(() => client.destroy());
            return false;
          },
        });
      });
    } finally {
      this.#probing--;
    }
  }
  async acquire(
    connection: NetworkConnection,
    credentials: NetworkCredentials,
    signal?: AbortSignal,
    owner = connection.id,
  ): Promise<SftpLease> {
    signal?.throwIfAborted();
    const key = connection.id + ":" + connection.updatedAt;
    let entry = this.#entries.get(key);
    if (!entry) {
      let pending = this.#pending.get(key);
      if (!pending) {
        if (
          this.#entries.size + this.#pending.size >= 32 ||
          [...this.#entries.values(), ...this.#pending.values()].filter((v) => v.owner === owner)
            .length >= 4
        )
          throw new ApiError(429, "RATE_LIMITED", "Too many remote connections");
        pending = {
          owner,
          promise: resolveNetworkHost(connection.host, this.allowLoopback),
          cancelled: false,
        };
        this.#pending.set(key, pending);
      }
      let address: string;
      try {
        address = await pending.promise;
      } finally {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
      }
      signal?.throwIfAborted();
      if (pending.cancelled) throw unavailable();
      if (this.#entries.has(key)) return this.acquire(connection, credentials, signal, owner);
      const client = new Client();
      let mismatch = false;
      const config: ConnectConfig = {
        host: address,
        port: connection.port,
        username: connection.username,
        readyTimeout: 10000,
        keepaliveInterval: 3000,
        keepaliveCountMax: 2,
        hostVerifier: (raw: Buffer) => {
          const matches = digest(raw) === connection.fingerprint;
          mismatch = !matches;
          return matches;
        },
        ...(credentials.password ? { password: credentials.password } : {}),
        ...(credentials.privateKey ? { privateKey: credentials.privateKey } : {}),
        ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
        tryKeyboard: false,
        agentForward: false,
      };
      const ready = new Promise<Client>((resolve, reject) => {
        client.once("ready", () => resolve(client));
        client.once("close", () => reject(unavailable()));
        client.once("error", (e: Error & { level?: string }) => {
          reject(
            mismatch
              ? new ApiError(409, "SHARING_HOST_KEY", "The SSH host key did not match")
              : e.level === "client-authentication"
                ? new ApiError(403, "SHARING_AUTH_FAILED", "Remote authentication failed")
                : unavailable(),
          );
        });
      });
      entry = { client, owner, ready, connected: false, active: 0, timer: null };
      this.#entries.set(key, entry);
      const created = entry;
      void ready.then(
        () => {
          created.connected = true;
        },
        () => undefined,
      );
      client.on("error", () => {
        if (this.#entries.get(key)?.client === client) this.close(connection.id);
      });
      client.on("close", () => {
        if (created.timer) clearTimeout(created.timer);
        if (this.#entries.get(key)?.client === client) this.#entries.delete(key);
      });
      try {
        client.connect(config);
      } catch {
        client.destroy();
        this.#entries.delete(key);
        throw new ApiError(400, "SHARING_AUTH_FAILED", "Invalid SSH authentication settings");
      }
    }
    const current = entry;
    if (current.active >= 4) throw new ApiError(429, "RATE_LIMITED", "Remote connection busy");
    if (current.timer) clearTimeout(current.timer);
    current.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.active--;
      if (!current.active && this.#entries.get(key) === current) {
        current.timer = setTimeout(() => {
          if (this.#entries.get(key) === current) this.close(connection.id);
        }, 30000);
        current.timer.unref();
      }
    };
    try {
      const client = await current.ready;
      signal?.throwIfAborted();
      const sftp = await timed<SFTPWrapper>(
        (cb) => client.sftp(cb),
        signal,
        (channel) => channel.end(),
      );
      return {
        client,
        sftp,
        release: () => {
          sftp.end();
          release();
        },
      };
    } catch (error) {
      release();
      throw sftpError(error);
    }
  }
}
function watchStream<T extends Readable>(stream: T, signal?: AbortSignal): T {
  let timer = setTimeout(() => stream.destroy(unavailable()), 12000);
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.destroy(unavailable()), 12000);
  };
  const abort = () => stream.destroy(new ApiError(409, "CANCELLED", "Cancelled"));
  stream.on("data", progress);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  stream.once("close", () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    stream.removeListener("data", progress);
  });
  return stream;
}
const modeString = (mode: number) =>
  [..."rwxrwxrwx"].map((v, i) => (mode & (1 << (8 - i)) ? v : "-")).join("");
const entryType = (s: Stats): FileEntry["type"] =>
  s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other";
const join = (...p: string[]) => p.filter(Boolean).join("/");

/** SFTP stays a remote file adapter; no FUSE, shell or locally executed remote content. */
export class SftpFiles {
  readonly connection: NetworkConnection;
  readonly pool: SftpPool;
  readonly credentials: NetworkCredentials;
  readonly signal: AbortSignal | undefined;
  readonly maxUploadBytes: number;
  readonly minFreeBytes: number;
  readonly owner: string;
  constructor(options: {
    connection: NetworkConnection;
    pool: SftpPool;
    credentials: NetworkCredentials;
    signal?: AbortSignal | undefined;
    maxUploadBytes: number;
    minFreeBytes?: number;
    owner: string;
  }) {
    this.connection = options.connection;
    this.pool = options.pool;
    this.credentials = options.credentials;
    this.signal = options.signal;
    this.maxUploadBytes = options.maxUploadBytes;
    this.minFreeBytes = options.minFreeBytes ?? 16 * 1024 ** 2;
    this.owner = options.owner;
  }
  #write() {
    if (this.connection.readOnly)
      throw new ApiError(403, "FILES_READ_ONLY", "Read-only remote folder");
  }
  async #with<T>(run: (s: SFTPWrapper, base: string) => Promise<T>): Promise<T> {
    const lease = await this.pool.acquire(
      this.connection,
      this.credentials,
      this.signal,
      this.owner,
    );
    try {
      return await run(
        lease.sftp,
        await timed<string>(
          (cb) => lease.sftp.realpath(this.connection.remotePath, cb),
          this.signal,
        ),
      );
    } catch (e) {
      throw sftpError(e);
    } finally {
      lease.release();
    }
  }
  async #path(s: SFTPWrapper, base: string, path: string, parentOnly = false) {
    if (!RelativePathSchema.safeParse(path).success)
      throw new ApiError(400, "VALIDATION_FAILED", "Invalid remote path");
    const parts = path.split("/").filter(Boolean);
    let current = base;
    for (const name of parentOnly ? parts.slice(0, -1) : parts) {
      FileNameSchema.parse(name);
      const next = posix.join(current, name);
      if (!(next === base || next.startsWith(base.replace(/\/$/, "") + "/")))
        throw new ApiError(403, "FORBIDDEN", "Invalid remote path");
      const info = await timed<Stats>((cb) => s.lstat(next, cb), this.signal);
      if (info.isSymbolicLink())
        throw new ApiError(403, "FORBIDDEN", "Remote symlinks cannot be followed");
      current = next;
    }
    return parentOnly && parts.length ? posix.join(current, parts.at(-1)!) : current;
  }
  list(_root: string, path: string, hidden: boolean): Promise<FileListing> {
    return this.#with(async (s, base) => {
      const target = await this.#path(s, base, path);
      const items = await timed<Array<{ filename: string; attrs: Stats }>>(
        (cb) => s.readdir(target, cb),
        this.signal,
      );
      const safe = items.filter(
        (v) =>
          FileNameSchema.safeParse(v.filename).success && (hidden || !v.filename.startsWith(".")),
      );
      return {
        root: this.connection.root,
        path,
        entries: safe.slice(0, 5000).map((v) => ({
          name: v.filename,
          type: entryType(v.attrs),
          size: Math.max(0, v.attrs.size),
          modifiedAt: v.attrs.mtime * 1000,
          mode: modeString(v.attrs.mode),
          link: v.attrs.isSymbolicLink() ? { inside: false as const } : null,
        })),
        truncated: safe.length > 5000,
      };
    });
  }
  properties(_root: string, path: string): Promise<FileProperties> {
    return this.#with(async (s, base) => {
      const target = await this.#path(s, base, path, true);
      const info = await timed<Stats>((cb) => s.lstat(target, cb), this.signal);
      return {
        root: this.connection.root,
        path,
        name: path.split("/").at(-1) || this.connection.name,
        type: entryType(info),
        size: info.size,
        modifiedAt: info.mtime * 1000,
        changedAt: info.mtime * 1000,
        createdAt: null,
        mode: modeString(info.mode),
        octal: (info.mode & 0o777).toString(8),
        owner: String(info.uid),
        group: String(info.gid),
        children: null,
        link: info.isSymbolicLink() ? { inside: false as const } : null,
      };
    });
  }
  async search(root: string, path: string, query: string): Promise<FileSearchResult> {
    const results: FileSearchResult["results"] = [];
    let visited = 0,
      truncated = false;
    const deadline = Date.now() + 8000;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 16 || visited > 10000 || Date.now() > deadline || results.length >= 300) {
        truncated = true;
        return;
      }
      const list = await this.list(root, directory, false);
      truncated ||= list.truncated;
      for (const item of list.entries) {
        if (++visited > 10000 || Date.now() > deadline || results.length >= 300) {
          truncated = true;
          break;
        }
        const child = join(directory, item.name);
        if (item.name.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr")))
          results.push({ path: child, name: item.name, type: item.type });
        if (item.type === "directory") await walk(child, depth + 1);
      }
    };
    await walk(path, 0);
    return { results, truncated };
  }
  async openFile(_root: string, path: string) {
    const lease = await this.pool.acquire(
      this.connection,
      this.credentials,
      this.signal,
      this.owner,
    );
    const s = lease.sftp;
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        lease.release();
      }
      return Promise.resolve();
    };
    try {
      const base = await timed<string>(
        (cb) => s.realpath(this.connection.remotePath, cb),
        this.signal,
      );
      const target = await this.#path(s, base, path);
      const info = await timed<Stats>((cb) => s.lstat(target, cb), this.signal);
      if (!info.isFile())
        throw new ApiError(400, "VALIDATION_FAILED", "A regular file is required");
      return {
        name: path.split("/").at(-1)!,
        size: info.size,
        modifiedAt: info.mtime * 1000,
        readAt: async (offset: number, length: number) => {
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > 4 * 1024 ** 2
          )
            throw new ApiError(400, "VALIDATION_FAILED", "Invalid range");
          if (length === 0) return Buffer.alloc(0);
          const chunks: Buffer[] = [];
          const stream = watchStream(
            s.createReadStream(target, { start: offset, end: offset + length - 1 }),
            this.signal,
          );
          for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
          return Buffer.concat(chunks);
        },
        handle: {
          close,
          createReadStream: (options: { start: number; end: number; autoClose?: boolean }) => {
            const stream = watchStream(
              s.createReadStream(target, { start: options.start, end: options.end }),
              this.signal,
            );
            if (options.autoClose !== false) stream.once("close", () => void close());
            const abort = () => stream.destroy(new ApiError(409, "CANCELLED", "Cancelled"));
            this.signal?.addEventListener("abort", abort, { once: true });
            stream.once("close", () => this.signal?.removeEventListener("abort", abort));
            return stream;
          },
        },
      };
    } catch (error) {
      await close();
      throw sftpError(error);
    }
  }
  async readText(root: string, path: string): Promise<TextFile> {
    const f = await this.openFile(root, path);
    try {
      if (f.size > MAX_TEXT_FILE_BYTES)
        throw new ApiError(413, "FILES_TOO_LARGE", "Text is too large");
      const b = f.size ? await f.readAt(0, f.size) : Buffer.alloc(0);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(b);
        if (content.includes("\0")) throw new Error();
      } catch {
        throw new ApiError(400, "FILES_NOT_TEXT", "Not UTF-8 text");
      }
      return {
        content,
        etag: '"' + f.size + ":" + f.modifiedAt / 1000 + '"',
        size: f.size,
        modifiedAt: f.modifiedAt,
      };
    } finally {
      await f.handle.close();
    }
  }
  async upload(
    _root: string,
    path: string,
    name: string,
    body: WebReadableStream<Uint8Array>,
    length: number,
    overwrite: boolean,
  ) {
    this.#write();
    FileNameSchema.parse(name);
    if (!Number.isSafeInteger(length) || length < 0 || length > this.maxUploadBytes)
      throw new ApiError(413, "FILES_TOO_LARGE", "File is too large");
    return this.#with(async (s, base) => {
      const parent = await this.#path(s, base, path),
        target = posix.join(parent, name);
      const space = await timed<{ frsize?: number; bavail?: number } | null>((cb) => {
        try {
          s.ext_openssh_statvfs(parent, (error, value: unknown) => {
            if (
              error &&
              ((error as { code?: number }).code === 8 || error.message.includes("not supported"))
            )
              cb(null, null);
            else cb(error, value as { frsize?: number; bavail?: number });
          });
        } catch (error) {
          if (error instanceof Error && /unsupported|not support/i.test(error.message))
            cb(null, null);
          else cb(error as Error, null);
        }
      }, this.signal);
      if (
        space &&
        Number.isSafeInteger(space.frsize) &&
        Number.isSafeInteger(space.bavail) &&
        space.frsize! * space.bavail! < length + this.minFreeBytes
      )
        throw new ApiError(
          507,
          "FILES_INSUFFICIENT_SPACE",
          "Remote filesystem has insufficient space",
        );
      const old = await timed<Stats>((cb) => s.lstat(target, cb), this.signal).catch(
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        },
      );
      if (old && (!overwrite || !old.isFile()))
        throw new ApiError(409, "CONFLICT", "Remote file exists");
      const temporary = posix.join(parent, ".everyos-upload-" + randomUUID());
      let bytes = 0,
        committed = false;
      let idle = setTimeout(() => count.destroy(unavailable()), 12000);
      const count = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length;
          clearTimeout(idle);
          idle = setTimeout(() => count.destroy(unavailable()), 12000);
          cb(
            bytes > length ? new ApiError(413, "FILES_TOO_LARGE", "Invalid upload length") : null,
            chunk,
          );
        },
      });
      const stream = s.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      try {
        await pipeline(
          Readable.fromWeb(body),
          count,
          stream,
          this.signal ? { signal: this.signal } : {},
        );
        if (bytes !== length) throw new ApiError(400, "VALIDATION_FAILED", "Invalid upload length");
        if (old)
          await timed<void>((cb) => s.ext_openssh_rename(temporary, target, cb), this.signal);
        else await timed<void>((cb) => s.rename(temporary, target, cb), this.signal);
        committed = true;
      } finally {
        clearTimeout(idle);
        if (!committed) await timed<void>((cb) => s.unlink(temporary, cb)).catch(() => undefined);
      }
    });
  }
  async writeText(root: string, path: string, content: string, expected: string | null) {
    this.#write();
    if (Buffer.byteLength(content) > MAX_TEXT_FILE_BYTES)
      throw new ApiError(413, "FILES_TOO_LARGE", "Text is too large");
    const old = await this.readText(root, path).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
    if (expected !== (old?.etag ?? null))
      throw new ApiError(409, "CONFLICT", "Remote file changed");
    await this.upload(
      root,
      posix.dirname(path) === "." ? "" : posix.dirname(path),
      posix.basename(path),
      Readable.toWeb(Readable.from([Buffer.from(content)])) as WebReadableStream<Uint8Array>,
      Buffer.byteLength(content),
      old !== null,
    );
    return this.readText(root, path);
  }
  async mkdir(_root: string, path: string, name: string) {
    this.#write();
    FileNameSchema.parse(name);
    return this.#with(async (s, base) => {
      const parent = await this.#path(s, base, path);
      await timed<void>(
        (cb) => s.mkdir(posix.join(parent, name), { mode: 0o700 }, cb),
        this.signal,
      );
    });
  }
  async rename(_root: string, path: string, name: string) {
    this.#write();
    FileNameSchema.parse(name);
    if (!path) throw new ApiError(403, "FILES_PROTECTED", "Remote root is protected");
    return this.#with(async (s, base) => {
      const source = await this.#path(s, base, path);
      await timed<void>(
        (cb) => s.rename(source, posix.join(posix.dirname(source), name), cb),
        this.signal,
      );
    });
  }
  async remove(root: string, paths: string[]) {
    this.#write();
    let count = 0;
    const walk = async (path: string, depth: number): Promise<void> => {
      if (!path || depth > 16 || ++count > 10000)
        throw new ApiError(400, "VALIDATION_FAILED", "Removal is too large");
      const info = await this.properties(root, path);
      if (info.type === "directory") {
        const list = await this.list(root, path, true);
        if (list.truncated) throw new ApiError(400, "VALIDATION_FAILED", "Removal is too large");
        for (const item of list.entries) await walk(join(path, item.name), depth + 1);
      }
      await this.#with(async (s, base) => {
        const target = await this.#path(s, base, path, true);
        await timed<void>(
          (cb) => (info.type === "directory" ? s.rmdir(target, cb) : s.unlink(target, cb)),
          this.signal,
        );
      });
    };
    for (const path of paths) await walk(path, 0);
  }
}
