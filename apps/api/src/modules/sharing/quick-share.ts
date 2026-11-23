import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PassThrough, Readable, Transform, addAbortSignal } from "node:stream";
import { pipeline } from "node:stream/promises";
import { roleHasPermission, ROLE_PERMISSIONS, type QuickShareView } from "@everyos/shared";
import { QuickShareInputSchema } from "@everyos/shared/schemas";
import type { z } from "zod";
import type { Services } from "../../services.ts";
import { ApiError } from "../../http/errors.ts";
import type { UserActor } from "../../http/agent.ts";
import { fileViewFor } from "../files/file-view.ts";
import { freeName } from "../drive/drive-transfers.ts";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { TransferProgress } from "../transfers/transfer-service.ts";

type Input = z.infer<typeof QuickShareInputSchema>;
type Config = Omit<Input, "password" | "lifetimeMinutes">;
interface Row {
  id: string;
  user_id: string;
  token_hash: string;
  sealed_token: string;
  password_hash: string | null;
  config: string;
  expires_at: number;
  downloads: number;
  bytes_received: number;
  reserved_bytes: number;
  uploads: number;
  reserved_uploads: number;
  revoked: number;
  claimed: number;
  created_at: number;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const expired = () => new ApiError(410, "SHARING_EXPIRED", "Share expired or revoked");

export class QuickShareService {
  readonly #services: () => Services;
  #passwordWork = 0;
  async #password<T>(run: () => Promise<T>) {
    if (this.#passwordWork >= 2)
      throw new ApiError(429, "RATE_LIMITED", "Password verification is busy");
    this.#passwordWork++;
    try {
      return await run();
    } finally {
      this.#passwordWork--;
    }
  }
  #rates = new Map<string, { at: number; count: number }>();
  constructor(services: () => Services) {
    this.#services = services;
  }
  get services() {
    return this.#services();
  }
  initialize() {
    // Transfers are process-local. No reservation survives an API restart.
    this.services.db.run("UPDATE quick_shares SET reserved_bytes=0,reserved_uploads=0");
    this.services.db.run("DELETE FROM quick_share_grants WHERE expires_at<=?", this.services.now());
  }
  #audit(action: string, id: string, outcome: "success" | "failure") {
    this.services.audit.record({
      action: "sharing.quick." + action,
      target: id,
      outcome,
      actor: null,
    });
  }
  #capacity(userId: string) {
    if (
      this.services.transfers
        .list(userId)
        .filter((j) => j.state === "queued" || j.state === "running").length >= 16
    )
      throw new ApiError(429, "RATE_LIMITED", "Transfer queue is full");
  }
  #view(row: Row): QuickShareView {
    const c = JSON.parse(row.config) as Config;
    return {
      id: row.id,
      name: c.name,
      direction: c.direction,
      root: c.root,
      paths: c.paths,
      expiresAt: row.expires_at,
      oneTime: c.oneTime,
      passwordProtected: row.password_hash !== null,
      claimed: row.claimed === 1,
      exhausted:
        c.direction === "send"
          ? row.downloads >= c.maxDownloads
          : row.bytes_received >= c.maxBytes || row.uploads >= 100,
      maxDownloads: c.maxDownloads,
      downloads: row.downloads,
      maxBytes: c.maxBytes,
      bytesReceived: row.bytes_received,
      revoked: row.revoked === 1,
      createdAt: row.created_at,
    };
  }
  list(userId: string) {
    return this.services.db
      .all<Row>(
        "SELECT * FROM quick_shares WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        userId,
      )
      .map((r) => this.#view(r));
  }
  #owner(row: Row) {
    const user = this.services.users.findById(row.user_id);
    if (
      !user ||
      user.disabled ||
      !roleHasPermission(user.role, "files:read") ||
      !roleHasPermission(user.role, "files:write") ||
      ((JSON.parse(row.config) as Config).root.startsWith("sys-") &&
        !roleHasPermission(user.role, "system:manage"))
    )
      throw expired();
    const actor: UserActor = {
      kind: "user",
      userId: user.id,
      username: user.username,
      role: user.role,
    };
    return { user, permissions: ROLE_PERMISSIONS[user.role], actor };
  }
  #files(row: Row, signal?: AbortSignal) {
    return fileViewFor(this.services, this.#owner(row), { signal, logger: this.services.logger });
  }
  #valid(row: Row | undefined) {
    if (!row || row.revoked || row.expires_at <= this.services.now()) throw expired();
    this.#owner(row);
    return row;
  }
  #row(id: string) {
    return this.#valid(this.services.db.get<Row>("SELECT * FROM quick_shares WHERE id=?", id));
  }
  rate(ip: string) {
    const now = this.services.now();
    if (this.#rates.size > 4096)
      for (const [key, value] of this.#rates) if (value.at + 60000 <= now) this.#rates.delete(key);
    if (this.#rates.size > 4096) throw new ApiError(429, "RATE_LIMITED", "Public sharing busy");
    let item = this.#rates.get(ip);
    if (!item || item.at + 60000 <= now) {
      item = { at: now, count: 0 };
      this.#rates.set(ip, item);
    }
    if (++item.count > 60) throw new ApiError(429, "RATE_LIMITED", "Too many sharing requests");
  }
  async create(input: Input, actor: UserActor) {
    input = QuickShareInputSchema.parse(input);
    if (!roleHasPermission(actor.role, "files:write"))
      throw new ApiError(403, "FORBIDDEN", "File write permission required");
    if (
      this.services.db.get<{ n: number }>(
        "SELECT count(*) n FROM quick_shares WHERE user_id=? AND revoked=0 AND expires_at>?",
        actor.userId,
        this.services.now(),
      )!.n >= 50
    )
      throw new ApiError(429, "RATE_LIMITED", "Active share limit reached");
    const { password, lifetimeMinutes, ...config } = input;
    if (config.oneTime && config.direction === "send") config.maxDownloads = config.paths.length;
    const id = randomUUID(),
      rawToken = token(),
      now = this.services.now();
    const row: Row = {
      id,
      user_id: actor.userId,
      token_hash: hash(rawToken),
      sealed_token: this.services.secrets.seal(rawToken, "quick-share:" + actor.userId + ":" + id),
      password_hash: password
        ? await this.#password(() => this.services.passwords.hash(password))
        : null,
      config: JSON.stringify(config),
      expires_at: now + lifetimeMinutes * 60000,
      downloads: 0,
      bytes_received: 0,
      reserved_bytes: 0,
      uploads: 0,
      reserved_uploads: 0,
      revoked: 0,
      claimed: 0,
      created_at: now,
    };
    const files = this.#files(row);
    if (input.direction === "send") {
      for (const path of input.paths) {
        const file = await files.properties(input.root, path);
        if (file.type !== "file")
          throw new ApiError(
            400,
            "VALIDATION_FAILED",
            "Compress folders with Files before sharing",
          );
      }
    } else {
      const folder = await files.properties(input.root, input.path);
      if (folder.type !== "directory")
        throw new ApiError(400, "VALIDATION_FAILED", "A destination folder is required");
      const root = (await files.roots(true)).find((r) => r.id === input.root);
      if (!root || root.readOnly || !root.available)
        throw new ApiError(403, "FILES_READ_ONLY", "Destination is not writable");
    }
    if (
      this.services.db.get<{ n: number }>(
        "SELECT count(*) n FROM quick_shares WHERE user_id=? AND revoked=0 AND expires_at>?",
        actor.userId,
        this.services.now(),
      )!.n >= 50
    )
      throw new ApiError(429, "RATE_LIMITED", "Active share limit reached");
    this.services.db.run(
      "INSERT INTO quick_shares (id,user_id,token_hash,sealed_token,password_hash,config,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
      id,
      actor.userId,
      row.token_hash,
      row.sealed_token,
      row.password_hash,
      row.config,
      row.expires_at,
      now,
    );
    this.services.sharing.audit(actor, "quick.create", id);
    return { share: this.#view(row), token: rawToken };
  }
  link(id: string, actor: UserActor) {
    const row = this.#row(id);
    if (row.user_id !== actor.userId) throw new ApiError(404, "NOT_FOUND", "Share not found");
    this.services.sharing.audit(actor, "quick.link", id);
    return this.services.secrets.open(row.sealed_token, "quick-share:" + actor.userId + ":" + id);
  }
  revoke(id: string, actor: UserActor) {
    const change = this.services.db.run(
      "UPDATE quick_shares SET revoked=1 WHERE id=? AND user_id=?",
      id,
      actor.userId,
    );
    if (!change.changes) throw new ApiError(404, "NOT_FOUND", "Share not found");
    this.services.db.run("DELETE FROM quick_share_grants WHERE share_id=?", id);
    this.services.sharing.audit(actor, "quick.revoke", id);
  }
  async access(raw: string, password: string | undefined, _ip: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw expired();
    const row = this.#valid(
      this.services.db.get<Row>("SELECT * FROM quick_shares WHERE token_hash=?", hash(raw)),
    );
    if (
      row.password_hash &&
      (!password ||
        !(await this.#password(() => this.services.passwords.verify(password, row.password_hash!)))
          .valid)
    )
      throw new ApiError(403, "SHARING_PASSWORD_REQUIRED", "Share password required");
    const grant = token();
    this.services.db.transaction(() => {
      this.#row(row.id);
      const config = JSON.parse(row.config) as Config;
      if (
        config.oneTime &&
        !this.services.db.run("UPDATE quick_shares SET claimed=1 WHERE id=? AND claimed=0", row.id)
          .changes
      )
        throw expired();
      this.services.db.run(
        "DELETE FROM quick_share_grants WHERE expires_at<=?",
        this.services.now(),
      );
      this.services.db.run(
        "INSERT INTO quick_share_grants (hash,share_id,expires_at) VALUES (?,?,?)",
        hash(grant),
        row.id,
        Math.min(row.expires_at, this.services.now() + 15 * 60000),
      );
    });
    this.#audit("access", row.id, "success");
    return {
      id: row.id,
      grant,
      expiresAt: Math.min(row.expires_at, this.services.now() + 15 * 60000),
    };
  }
  grant(id: string, grant: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(grant)) throw expired();
    if (
      !this.services.db.get(
        "SELECT hash FROM quick_share_grants WHERE hash=? AND share_id=? AND expires_at>?",
        hash(grant),
        id,
        this.services.now(),
      )
    )
      throw expired();
    return this.#row(id);
  }
  async metadata(id: string, grant: string) {
    const row = this.grant(id, grant),
      c = JSON.parse(row.config) as Config;
    const files = this.#files(row);
    const entries = [];
    if (c.direction === "send")
      for (let index = 0; index < c.paths.length; index++) {
        const file = await files.properties(c.root, c.paths[index]!);
        if (file.type === "file") entries.push({ index, name: file.name, size: file.size });
      }
    return {
      id,
      name: c.name,
      direction: c.direction,
      expiresAt: row.expires_at,
      maxBytes: c.maxBytes,
      bytesReceived: row.bytes_received,
      entries,
    };
  }
  async download(
    id: string,
    grant: string,
    index: number,
    signal: AbortSignal,
    range?: { start: number; end: number },
  ) {
    const row = this.grant(id, grant),
      c = JSON.parse(row.config) as Config;
    if (c.direction !== "send" || !Number.isInteger(index) || index < 0 || index >= c.paths.length)
      throw new ApiError(404, "NOT_FOUND", "File not found");
    const info = await this.#files(row).properties(c.root, c.paths[index]!);
    if (info.type !== "file") throw new ApiError(404, "NOT_FOUND", "File not found");
    const start = range?.start ?? 0,
      end = range?.end ?? info.size - 1;
    if (start < 0 || (info.size > 0 && (end < start || end >= info.size)))
      throw new ApiError(416, "VALIDATION_FAILED", "Invalid range");
    this.#capacity(row.user_id);
    this.services.db.transaction(() => {
      this.grant(id, grant);
      if (
        !this.services.db.run(
          "UPDATE quick_shares SET downloads=downloads+1 WHERE id=? AND downloads<?",
          id,
          c.maxDownloads,
        ).changes
      )
        throw new ApiError(409, "SHARING_QUOTA", "Download limit reached");
    });
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    const transfer = this.services.transfers.start(row.user_id, {
      direction: "download",
      name: info.name,
      from: "Quick Share",
      to: info.name,
      bytesTotal: Math.max(0, end - start + 1),
      itemsTotal: 1,
      run: async (progress, taskSignal) =>
        this.services.files.withAccess(row.user_id, async () => {
          const combined = AbortSignal.any([
            signal,
            taskSignal,
            AbortSignal.timeout(Math.max(1, row.expires_at - this.services.now())),
          ]);
          let file: Awaited<ReturnType<ReturnType<typeof fileViewFor>["openFile"]>> | undefined;
          try {
            file = await this.#files(this.grant(id, grant), combined).openFile(
              c.root,
              c.paths[index]!,
            );
            if (file.size !== info.size || file.modifiedAt !== info.modifiedAt)
              throw new ApiError(409, "CONFLICT", "Shared file changed");
            const stream = info.size
              ? file.handle.createReadStream({ start, end })
              : Readable.from([]);
            await pipeline(
              stream,
              new Transform({
                transform: (chunk: Buffer, _encoding, cb) => {
                  try {
                    this.grant(id, grant);
                    progress.bytes(chunk.length);
                    cb(null, chunk);
                  } catch (error) {
                    cb(error as Error);
                  }
                },
              }),
              output,
              { signal: combined },
            );
            progress.item();
            this.#audit("download", id, "success");
          } catch (error) {
            this.#audit("download", id, "failure");
            output.destroy(error as Error);
            throw error;
          } finally {
            await file?.handle.close().catch(() => undefined);
          }
        }),
    });
    const cancel = () => {
      try {
        this.services.transfers.cancel(row.user_id, transfer.id);
      } catch {
        /* Already finished. */
      }
    };
    const unsubscribe = this.services.transfers.subscribe(row.user_id, (jobs) => {
      const job = jobs.find((j) => j.id === transfer.id);
      if (job?.state === "cancelled" || job?.state === "failed")
        output.destroy(
          new ApiError(
            409,
            job.state === "cancelled" ? "CANCELLED" : "TRANSFER_FAILED",
            "Transfer ended",
          ),
        );
    });
    output.once("close", () => {
      unsubscribe();
      if (!output.readableEnded) cancel();
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    output.once("close", () => signal.removeEventListener("abort", cancel));
    output.on("error", () => undefined);
    return {
      stream: output,
      name: info.name,
      size: info.size,
      length: Math.max(0, end - start + 1),
      transferId: transfer.id,
    };
  }
  async upload(
    id: string,
    grant: string,
    name: string,
    body: WebReadableStream<Uint8Array>,
    length: number,
    requestSignal: AbortSignal,
  ) {
    const row = this.grant(id, grant),
      c = JSON.parse(row.config) as Config;
    if (c.direction !== "receive")
      throw new ApiError(403, "FORBIDDEN", "This share cannot receive");
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > this.services.config.files.maxUploadBytes
    )
      throw new ApiError(413, "FILES_TOO_LARGE", "Upload too large");
    this.#capacity(row.user_id);
    this.services.db.transaction(() => {
      this.grant(id, grant);
      if (
        !this.services.db.run(
          "UPDATE quick_shares SET reserved_bytes=reserved_bytes+?,reserved_uploads=reserved_uploads+1 WHERE id=? AND bytes_received+reserved_bytes+?<=? AND uploads+reserved_uploads<100",
          length,
          id,
          length,
          c.maxBytes,
        ).changes
      )
        throw new ApiError(409, "SHARING_QUOTA", "Upload quota exceeded");
    });
    let complete!: () => void, failed!: (e: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      complete = resolve;
      failed = reject;
    });
    done.catch(() => undefined);
    let received = false;
    const transfer = this.services.transfers.start(row.user_id, {
      direction: "upload",
      name,
      from: "Quick Share",
      to: c.name,
      bytesTotal: length,
      itemsTotal: 1,
      run: async (progress: TransferProgress, signal) => {
        try {
          const combined = AbortSignal.any([
            signal,
            requestSignal,
            AbortSignal.timeout(Math.max(1, row.expires_at - this.services.now())),
          ]);
          await this.services.files.withAccess(row.user_id, async () => {
            const files = this.#files(this.grant(id, grant), combined);
            const listing = await files.list(c.root, c.path, true);
            if (listing.truncated)
              throw new ApiError(409, "CONFLICT", "Destination listing too large");
            const targetName = freeName(name, new Set(listing.entries.map((e) => e.name)));
            let bytes = 0;
            const source = addAbortSignal(combined, Readable.fromWeb(body));
            const validate = () => this.grant(id, grant);
            const stream = addAbortSignal(
              combined,
              Readable.from(
                (async function* () {
                  for await (const data of source) {
                    validate();
                    const chunk = Buffer.from(data as Uint8Array);
                    bytes += chunk.length;
                    if (bytes > length)
                      throw new ApiError(413, "FILES_TOO_LARGE", "Invalid upload length");
                    progress.bytes(chunk.length);
                    yield chunk;
                  }
                })(),
              ),
            );
            try {
              await files.upload(
                c.root,
                c.path,
                targetName,
                Readable.toWeb(stream) as WebReadableStream<Uint8Array>,
                length,
                false,
              );
            } finally {
              stream.destroy();
              source.destroy();
            }
            if (bytes !== length)
              throw new ApiError(400, "VALIDATION_FAILED", "Invalid upload length");
            received = true;
            this.#audit("upload", id, "success");
            progress.item();
            complete();
          });
        } catch (error) {
          this.#audit("upload", id, "failure");
          failed(error);
          throw error;
        }
      },
    });
    const cancel = () => {
      this.services.transfers.cancel(row.user_id, transfer.id);
      failed(new ApiError(409, "CANCELLED", "Cancelled"));
    };
    requestSignal.addEventListener("abort", cancel, { once: true });
    if (requestSignal.aborted) cancel();
    // A queued task may be cancelled before run() begins; observe its terminal state too.
    const unsubscribe = this.services.transfers.subscribe(row.user_id, (jobs) => {
      if (jobs.find((j) => j.id === transfer.id)?.state === "cancelled")
        failed(new ApiError(409, "CANCELLED", "Cancelled"));
    });
    try {
      await done;
      return { transferId: transfer.id };
    } finally {
      unsubscribe();
      requestSignal.removeEventListener("abort", cancel);
      this.services.db.run(
        "UPDATE quick_shares SET reserved_bytes=max(0,reserved_bytes-?),reserved_uploads=max(0,reserved_uploads-1),uploads=uploads+?,bytes_received=bytes_received+? WHERE id=?",
        length,
        received ? 1 : 0,
        received ? length : 0,
        id,
      );
    }
  }
}
