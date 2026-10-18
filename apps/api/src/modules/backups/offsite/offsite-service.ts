import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import {
  diskRootId,
  DRIVE_ROOT,
  ENCRYPTED_BACKUP_EXTENSION,
  ROLE_PERMISSIONS,
  type OffsiteTargetView,
  type OffsiteView,
} from "@everyos/shared";
import type { OffsiteTargetRequestSchema } from "@everyos/shared/schemas";
import type { z } from "zod";
import type { UserActor } from "../../../http/agent.ts";
import { ApiError } from "../../../http/errors.ts";
import type { DriveService } from "../../drive/drive-service.ts";
import type { FileUser, FileView } from "../../files/file-view.ts";
import type { DiskService } from "../../system/disks.ts";
import type { User, UserRepository } from "../../users/user-repository.ts";
import { encryptionView } from "../encryption.ts";
import { S3Client, S3Error, validateS3Target, type S3ClientOptions } from "./s3-client.ts";

/*
 * Where encrypted copies of backups go (docs/backups.md): a mounted EveryOS disk (written as the
 * administrator's Linux account, like Files), S3-compatible object storage, or an
 * administrator's Google Drive. Only files EveryOS names `everyos-backup-<id>.eosbak` are ever
 * listed or removed there.
 */

const SETTINGS_KEY = "backups.offsite";
const S3_SECRET_CONTEXT = "backups:offsite:s3:v1";

export const OFFSITE_FILE = /^everyos-backup-(\d{8}-\d{6}-[a-f0-9]{6})\.eosbak$/;
export const offsiteName = (backupId: string) =>
  `everyos-backup-${backupId}${ENCRYPTED_BACKUP_EXTENSION}`;

type StoredTarget =
  | { kind: "disk"; uuid: string; folder: string; userId: string }
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      pathStyle: boolean;
      accessKeyId: string;
      secret: string;
    }
  | { kind: "drive"; folder: string; userId: string };

interface StoredSettings {
  target: StoredTarget | null;
  keep: number;
  auto: boolean;
}

const DEFAULTS: StoredSettings = { target: null, keep: 7, auto: true };

export type OffsiteTargetRequest = z.infer<typeof OffsiteTargetRequestSchema>;

/** One destination, opened for a single copy (or a connection test). */
export interface OffsiteDestination {
  label: string;
  /** Names of EveryOS backup copies there. */
  list(signal: AbortSignal): Promise<string[]>;
  put(
    name: string,
    body: AsyncIterable<Uint8Array>,
    size: number,
    signal: AbortSignal,
    onProgress: (bytes: number) => void,
  ): Promise<void>;
  remove(name: string, signal: AbortSignal): Promise<void>;
}

export const offsiteFailure = (reason: string) =>
  new ApiError(409, "BACKUP_OFFSITE_FAILED", "The off-site copy failed", { details: { reason } });

/** A short machine-readable reason for a failed copy (shown translated in the UI). */
export function offsiteReason(error: unknown): string {
  if (error instanceof S3Error) return `s3:${error.code}`.slice(0, 80);
  if (error instanceof ApiError) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === "string" ? reason.slice(0, 80) : error.code;
  }
  return "network";
}

export interface OffsiteServiceDependencies {
  db: Database;
  secrets: SecretBox;
  users: UserRepository;
  drive: DriveService;
  disks: DiskService;
  fileView: (
    who: FileUser,
    options: { signal?: AbortSignal | undefined; logger: Logger },
  ) => FileView;
  logger: Logger;
  now: () => number;
  /** Test hook: S3 client options (retry delay, part size). */
  s3?: S3ClientOptions;
}

export class OffsiteService {
  readonly #deps: OffsiteServiceDependencies;

  constructor(deps: OffsiteServiceDependencies) {
    this.#deps = deps;
  }

  settings(): StoredSettings {
    const row = this.#deps.db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      SETTINGS_KEY,
    );
    return row ? { ...DEFAULTS, ...(JSON.parse(row.value) as StoredSettings) } : { ...DEFAULTS };
  }

  #write(settings: StoredSettings): void {
    this.#deps.db.run(
      `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      SETTINGS_KEY,
      JSON.stringify(settings),
      this.#deps.now(),
    );
  }

  async view(): Promise<OffsiteView> {
    const { target, keep, auto } = this.settings();
    return {
      target: target ? await this.#targetView(target) : null,
      keep,
      auto,
      encryption: encryptionView(this.#deps.db),
    };
  }

  async #targetView(target: StoredTarget): Promise<OffsiteTargetView> {
    const username = (id: string) => this.#deps.users.findById(id)?.username ?? null;
    switch (target.kind) {
      case "disk": {
        const volume = await this.#deps.disks.volume(target.uuid).catch(() => null);
        return {
          kind: "disk",
          uuid: target.uuid,
          label: volume?.managed ? (volume.label ?? volume.uuid) : null,
          folder: target.folder,
          username: username(target.userId),
        };
      }
      case "s3":
        return {
          kind: "s3",
          endpoint: target.endpoint,
          region: target.region,
          bucket: target.bucket,
          prefix: target.prefix,
          pathStyle: target.pathStyle,
          accessKeyId: target.accessKeyId,
        };
      case "drive": {
        const account = await this.#deps.drive.account(target.userId).catch(() => null);
        return {
          kind: "drive",
          username: username(target.userId),
          folder: target.folder,
          connected: account?.account?.status === "connected",
        };
      }
    }
  }

  /**
   * Saves the destination after proving it works (listing it, creating the folder when needed).
   * Disk and Drive copies are written as the administrator saving them.
   */
  async update(
    request: { target: OffsiteTargetRequest | null; keep: number; auto: boolean },
    actor: UserActor,
    signal: AbortSignal,
  ): Promise<OffsiteView> {
    const current = this.settings();
    let target: StoredTarget | null = null;
    if (request.target?.kind === "disk") {
      const volume = await this.#deps.disks.volume(request.target.uuid);
      if (!volume?.managed) throw offsiteFailure("disk-not-mounted");
      if (volume.readOnly) throw offsiteFailure("disk-read-only");
      target = { ...request.target, userId: actor.userId };
    } else if (request.target?.kind === "s3") {
      const { secretAccessKey, ...rest } = request.target;
      const previous = current.target?.kind === "s3" ? current.target : null;
      const secret =
        secretAccessKey ??
        (previous ? this.#deps.secrets.open(previous.secret, S3_SECRET_CONTEXT) : null);
      if (!secret)
        throw new ApiError(400, "VALIDATION_FAILED", "The secret access key is required", {
          details: { reason: "secret" },
        });
      const prefix = rest.prefix && !rest.prefix.endsWith("/") ? `${rest.prefix}/` : rest.prefix;
      const problem = validateS3Target({ ...rest, prefix, secretAccessKey: secret });
      if (problem)
        throw new ApiError(400, "VALIDATION_FAILED", "The storage settings are invalid", {
          details: { reason: problem },
        });
      target = {
        ...rest,
        prefix,
        secret: this.#deps.secrets.seal(secret, S3_SECRET_CONTEXT),
      };
    } else if (request.target?.kind === "drive") {
      const account = await this.#deps.drive.account(actor.userId);
      if (account.account?.status !== "connected") throw offsiteFailure("drive-not-connected");
      target = { ...request.target, userId: actor.userId };
    }
    if (target) {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      try {
        await (await this.#open(target, timeout)).list(timeout);
      } catch (error) {
        throw offsiteFailure(offsiteReason(error));
      }
    }
    this.#write({ target, keep: request.keep, auto: request.auto });
    return this.view();
  }

  /** Lists the destination now. */
  async test(signal: AbortSignal): Promise<void> {
    const destination = await this.open(signal);
    try {
      await destination.list(signal);
    } catch (error) {
      throw offsiteFailure(offsiteReason(error));
    }
  }

  async open(signal: AbortSignal): Promise<OffsiteDestination> {
    const { target } = this.settings();
    if (!target)
      throw new ApiError(409, "BACKUP_OFFSITE_NOT_CONFIGURED", "No off-site destination is set");
    return this.#open(target, signal);
  }

  /** The administrator a disk or Drive destination acts as, while they still may. */
  #owner(userId: string): User {
    const user = this.#deps.users.findById(userId);
    if (!user || user.disabled || !ROLE_PERMISSIONS[user.role].has("backups:restore"))
      throw offsiteFailure("owner-unauthorized");
    return user;
  }

  async #open(target: StoredTarget, signal: AbortSignal): Promise<OffsiteDestination> {
    switch (target.kind) {
      case "s3":
        return this.#s3(target);
      case "drive":
        return this.#drive(target);
      case "disk":
        return this.#disk(target, signal);
    }
  }

  #s3(target: Extract<StoredTarget, { kind: "s3" }>): OffsiteDestination {
    const client = new S3Client(
      {
        endpoint: target.endpoint,
        region: target.region,
        bucket: target.bucket,
        prefix: target.prefix,
        pathStyle: target.pathStyle,
        accessKeyId: target.accessKeyId,
        secretAccessKey: this.#deps.secrets.open(target.secret, S3_SECRET_CONTEXT),
      },
      this.#deps.s3,
    );
    return {
      label: `S3 ${target.bucket}/${target.prefix}`.replace(/\/$/, ""),
      list: async (signal) =>
        (await client.list(signal)).map((entry) => entry.name).filter((n) => OFFSITE_FILE.test(n)),
      put: (name, body, size, signal, onProgress) =>
        client.put(name, body, size, {
          signal,
          contentType: "application/octet-stream",
          onProgress: (() => {
            let reported = 0;
            return (sent: number) => {
              onProgress(sent - reported);
              reported = sent;
            };
          })(),
        }),
      remove: (name, signal) => client.delete(name, signal),
    };
  }

  #drive(target: Extract<StoredTarget, { kind: "drive" }>): OffsiteDestination {
    const { drive } = this.#deps;
    const userId = this.#owner(target.userId).id;
    let folder: Promise<string> | null = null;
    const folderId = () =>
      (folder ??= (async () => {
        const existing = await drive.findChild(userId, DRIVE_ROOT, target.folder, true);
        return (existing ?? (await drive.createFolder(userId, DRIVE_ROOT, target.folder))).id;
      })());
    const copies = async () => {
      const id = await folderId();
      const found: Array<{ id: string; name: string }> = [];
      let pageToken: string | undefined;
      do {
        const page = await drive.list(userId, id, pageToken);
        found.push(
          ...page.entries.filter((entry) => !entry.folder && OFFSITE_FILE.test(entry.name)),
        );
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken && found.length < 10_000);
      return found;
    };
    return {
      label: `Google Drive/${target.folder}`,
      list: async () => (await copies()).map((entry) => entry.name),
      put: async (name, body, size, signal, onProgress) => {
        await drive.upload(userId, await folderId(), name, body, size, signal, onProgress);
      },
      remove: async (name) => {
        for (const entry of (await copies()).filter((candidate) => candidate.name === name))
          await drive.remove(userId, entry.id);
      },
    };
  }

  async #disk(
    target: Extract<StoredTarget, { kind: "disk" }>,
    signal: AbortSignal,
  ): Promise<OffsiteDestination> {
    const owner = this.#owner(target.userId);
    const who: FileUser = {
      user: { id: owner.id, username: owner.username, locale: owner.locale },
      permissions: ROLE_PERMISSIONS[owner.role],
      actor: {
        kind: "user",
        userId: owner.id,
        username: owner.username,
        role: owner.role,
        ip: "backups",
      },
    };
    const files = this.#deps.fileView(who, { signal, logger: this.#deps.logger });
    const root = diskRootId(target.uuid);
    if (!(await files.roots(true)).some((entry) => entry.id === root && !entry.readOnly))
      throw offsiteFailure(
        "hasLinuxAccount" in files && !(await files.hasLinuxAccount())
          ? "LINUX_ACCOUNT_REQUIRED"
          : "disk-not-mounted",
      );
    const listing = await files.list(root, "", true);
    if (
      !listing.entries.some((entry) => entry.name === target.folder && entry.type === "directory")
    )
      await files.mkdir(root, "", target.folder);
    return {
      label: `${target.uuid}/${target.folder}`,
      list: async () =>
        (await files.list(root, target.folder, true)).entries
          .filter((entry) => entry.type === "file" && OFFSITE_FILE.test(entry.name))
          .map((entry) => entry.name),
      put: async (name, body, size, _signal, onProgress) => {
        // Written under a hidden name and renamed when complete, so a copy is whole or absent.
        const partial = `.${name}.partial`;
        const counted = (async function* () {
          for await (const chunk of body) {
            yield chunk;
            onProgress(chunk.length);
          }
        })();
        try {
          await files.upload(
            root,
            target.folder,
            partial,
            Readable.toWeb(Readable.from(counted)) as WebReadableStream<Uint8Array>,
            size,
            true,
          );
          await files.rename(root, `${target.folder}/${partial}`, name);
        } catch (error) {
          await this.#discard(files, root, `${target.folder}/${partial}`).catch(() => undefined);
          throw error;
        }
      },
      remove: (name) => this.#discard(files, root, `${target.folder}/${name}`),
    };
  }

  /** Deletes for good: Files removals go to the disk's trash first, which would keep the space. */
  async #discard(files: FileView, root: string, path: string): Promise<void> {
    await files.remove(root, [path]);
    const trash = await files.trash();
    const ids = trash.entries
      .filter((entry) => entry.root === root && entry.path === path)
      .map((entry) => entry.id);
    if (ids.length) await files.deleteTrash(root, ids);
  }
}
