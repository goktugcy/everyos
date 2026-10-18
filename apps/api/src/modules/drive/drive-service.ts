import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import {
  DRIVE_EXPORTS,
  DRIVE_FOLDER_MIME,
  DRIVE_ROOT,
  DRIVE_SCOPE,
  DRIVE_SHARED,
  type DriveAccount,
  type DriveAccountView,
  type DriveClientView,
  type DriveEntry,
  type DriveListing,
} from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import { rechunk } from "../../http/streams.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { GoogleHttpError, readText, statusError, type GoogleHttp } from "./google-http.ts";

const CLIENT_KEY = "drive.client";
const CLIENT_CONTEXT = "drive:client:secret:v1";
const tokenContext = (userId: string) => `drive:${userId}:token:v1`;
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const ENTRY_FIELDS =
  "id,name,mimeType,size,modifiedTime,parents,capabilities(canEdit),shortcutDetails(targetId,targetMimeType)";
/** Pending consents, by state, for ten minutes. */
const CONSENT_MS = 10 * 60_000;
/** Google's export limit is 10 MB; anything beyond this is refused while buffering. */
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

interface ClientRow {
  clientId: string;
  sealedSecret: string;
}
interface AccountRow {
  user_id: string;
  email: string;
  name: string | null;
  sealed_token: string;
  status: "connected" | "reconnect";
  connected_at: number;
}
interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  capabilities?: { canEdit?: boolean };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

/** A Drive API request made with the person's token. */
interface RawRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  json?: unknown;
  headers?: Record<string, string>;
  body?: Readable | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  url?: string;
}

/** A Drive file as a transfer reads it. */
/** Resumable upload chunks (Google requires multiples of 256 KiB). */
const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

export interface DriveDownload {
  name: string;
  /** Null for exported Google Docs files until they are read. */
  sizeBytes: number | null;
  stream: IncomingMessage;
}

/** Maps Google failures onto EveryOS's error codes. */
export function driveError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof GoogleHttpError) {
    if (error.kind === "status") {
      if (error.status === 404) return new ApiError(404, "NOT_FOUND", "Drive item not found");
      if (error.reason === "storageQuotaExceeded" || error.reason === "quotaExceeded")
        return new ApiError(507, "DRIVE_QUOTA_EXCEEDED", "Drive storage is full");
      if (
        error.reason === "rateLimitExceeded" ||
        error.reason === "userRateLimitExceeded" ||
        error.status === 429
      )
        return new ApiError(429, "RATE_LIMITED", "Google asked to slow down");
      if (error.reason === "cannotExportFile" || error.reason === "fileNotDownloadable")
        return new ApiError(409, "DRIVE_NOT_DOWNLOADABLE", "This file cannot be downloaded");
      if (error.status === 403) return new ApiError(403, "FORBIDDEN", "Drive refused the request");
      if (error.status === 400)
        return new ApiError(400, "VALIDATION_FAILED", "Drive rejected the request");
    }
    return new ApiError(503, "DRIVE_UNAVAILABLE", "Google Drive is unavailable");
  }
  return new ApiError(503, "DRIVE_UNAVAILABLE", "Google Drive is unavailable");
}

function entryOf(file: RawFile): DriveEntry {
  // A shortcut stands for its target.
  const id =
    file.mimeType === SHORTCUT_MIME ? (file.shortcutDetails?.targetId ?? file.id) : file.id;
  const mimeType =
    file.mimeType === SHORTCUT_MIME
      ? (file.shortcutDetails?.targetMimeType ?? file.mimeType)
      : file.mimeType;
  const folder = mimeType === DRIVE_FOLDER_MIME;
  const exportAs = DRIVE_EXPORTS[mimeType]?.extension ?? null;
  const size = file.size !== undefined ? Number(file.size) : NaN;
  const modified = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
  return {
    id,
    name: file.name.slice(0, 255),
    mimeType,
    folder,
    sizeBytes: Number.isFinite(size) ? size : null,
    modifiedAt: Number.isFinite(modified) ? modified : null,
    exportAs,
    downloadable:
      folder || !mimeType.startsWith("application/vnd.google-apps.") || exportAs !== null,
    canEdit: file.capabilities?.canEdit ?? false,
  };
}

/** A safe local name for a Drive file (Drive allows "/" and other characters files cannot hold). */
export function localName(entry: Pick<DriveEntry, "name" | "exportAs">): string {
  let name =
    entry.name
      .replace(/[/\\\0]/g, "_")
      .replace(/^\.+$/, "_")
      .trim() || "_";
  if (entry.exportAs && !name.toLowerCase().endsWith(`.${entry.exportAs}`))
    name = `${name}.${entry.exportAs}`;
  return name.slice(0, 255);
}

/**
 * Google Drive for each person (docs/drive.md). The administrator's OAuth client is sealed in
 * instance settings; each person's refresh token is sealed per account. Access tokens live only
 * in memory.
 */
export class DriveService {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #http: GoogleHttp;
  readonly #logger: Logger;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #consents = new Map<
    string,
    { userId: string; verifier: string; redirectUri: string; expires: number }
  >();
  readonly #tokens = new Map<string, { token: string; expires: number }>();
  readonly #refreshing = new Map<string, Promise<string>>();
  readonly #quota = new Map<string, { at: number; quota: DriveAccount["quota"] }>();

  constructor(deps: {
    db: Database;
    secrets: SecretBox;
    http: GoogleHttp;
    logger: Logger;
    audit: AuditLog;
    now: () => number;
  }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#http = deps.http;
    this.#logger = deps.logger.child({ component: "drive" });
    this.#audit = deps.audit;
    this.#now = deps.now;
  }

  /* --------------------------------- client --------------------------------- */

  #client(): { clientId: string; clientSecret: string } | null {
    const row = this.#db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      CLIENT_KEY,
    );
    if (!row) return null;
    const parsed = JSON.parse(row.value) as ClientRow;
    return {
      clientId: parsed.clientId,
      clientSecret: this.#secrets.open(parsed.sealedSecret, CLIENT_CONTEXT),
    };
  }

  client(): DriveClientView {
    const client = this.#client();
    return { configured: client !== null, clientId: client?.clientId ?? null };
  }

  setClient(
    input: { clientId: string; clientSecret?: string | undefined },
    actor: Actor,
  ): DriveClientView {
    const current = this.#client();
    const secret =
      input.clientSecret ?? (current?.clientId === input.clientId ? current.clientSecret : null);
    if (!secret)
      throw new ApiError(422, "VALIDATION_FAILED", "The client secret is required", {
        details: { reason: "secret-required" },
      });
    const value: ClientRow = {
      clientId: input.clientId,
      sealedSecret: this.#secrets.seal(secret, CLIENT_CONTEXT),
    };
    this.#db.run(
      `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      CLIENT_KEY,
      JSON.stringify(value),
      this.#now(),
    );
    // Tokens belong to the client that issued them.
    if (current && current.clientId !== input.clientId) this.#forgetAll();
    this.#event("client.update", actor, "success", { clientId: input.clientId });
    return this.client();
  }

  clearClient(actor: Actor): void {
    this.#db.run("DELETE FROM instance_settings WHERE key = ?", CLIENT_KEY);
    this.#forgetAll();
    this.#event("client.delete", actor, "success");
  }

  #forgetAll(): void {
    this.#db.run("DELETE FROM drive_accounts");
    this.#tokens.clear();
    this.#quota.clear();
  }

  #requireClient() {
    const client = this.#client();
    if (!client) throw new ApiError(409, "DRIVE_NOT_CONFIGURED", "No Google client is registered");
    return client;
  }

  /* -------------------------------- accounts -------------------------------- */

  #row(userId: string): AccountRow | null {
    return (
      this.#db.get<AccountRow>("SELECT * FROM drive_accounts WHERE user_id = ?", userId) ?? null
    );
  }

  async account(userId: string): Promise<DriveAccountView> {
    const configured = this.#client() !== null;
    const row = configured ? this.#row(userId) : null;
    if (!row) return { configured, account: null };
    let quota = this.#quota.get(userId);
    if (row.status === "connected" && (!quota || this.#now() - quota.at > 5 * 60_000)) {
      try {
        const about = await this.#api<{
          storageQuota?: { usage?: string; limit?: string };
        }>(userId, { method: "GET", path: "/drive/v3/about?fields=storageQuota(usage,limit)" });
        const number = (value?: string) =>
          value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
        quota = {
          at: this.#now(),
          quota: {
            usedBytes: number(about.storageQuota?.usage),
            limitBytes: number(about.storageQuota?.limit),
          },
        };
        this.#quota.set(userId, quota);
      } catch (error) {
        this.#logger.debug("Drive quota unavailable", { error: (error as Error).message });
      }
    }
    const current = this.#row(userId) ?? row;
    return {
      configured,
      account: {
        email: current.email,
        name: current.name,
        status: current.status,
        quota: quota?.quota ?? null,
        connectedAt: current.connected_at,
      },
    };
  }

  /** The consent page for the person, with PKCE; Google sends the browser to `redirectUri`. */
  begin(userId: string, redirectUri: string): { url: string } {
    const client = this.#requireClient();
    const now = this.#now();
    for (const [state, consent] of this.#consents)
      if (consent.expires < now || consent.userId === userId) this.#consents.delete(state);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.#consents.set(state, { userId, verifier, redirectUri, expires: now + CONSENT_MS });
    const url = new URL("/o/oauth2/v2/auth", this.#http.endpoints.accounts);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      // Always returns a refresh token, also when the person connected before.
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString() };
  }

  async complete(
    userId: string,
    code: string,
    state: string,
    actor: Actor,
  ): Promise<DriveAccountView> {
    const consent = this.#consents.get(state);
    if (!consent || consent.userId !== userId || consent.expires < this.#now())
      throw new ApiError(
        400,
        "DRIVE_AUTH_FAILED",
        "The Google consent expired or was not started here",
      );
    this.#consents.delete(state);
    const client = this.#requireClient();
    let tokens: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    try {
      tokens = await this.#http.json({
        method: "POST",
        url: `${this.#http.endpoints.oauth}/token`,
        form: {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code,
          code_verifier: consent.verifier,
          grant_type: "authorization_code",
          redirect_uri: consent.redirectUri,
        },
      });
    } catch (error) {
      this.#event("account.connect", actor, "failure", { reason: reasonOf(error) });
      throw error instanceof GoogleHttpError && error.kind === "status"
        ? new ApiError(400, "DRIVE_AUTH_FAILED", "Google did not accept the authorization")
        : driveError(error);
    }
    if (
      !tokens.refresh_token ||
      !tokens.access_token ||
      !tokens.scope?.split(" ").includes(DRIVE_SCOPE)
    ) {
      this.#event("account.connect", actor, "failure", { reason: "scope" });
      throw new ApiError(400, "DRIVE_AUTH_FAILED", "Google did not grant Drive access");
    }
    this.#tokens.set(userId, {
      token: tokens.access_token,
      expires: this.#now() + Math.max(60, tokens.expires_in ?? 3600) * 1000,
    });
    const about = await this.#http
      .json<{ user?: { emailAddress?: string; displayName?: string } }>({
        method: "GET",
        url: `${this.#http.endpoints.api}/drive/v3/about?fields=user(emailAddress,displayName)`,
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      .catch((error: unknown) => {
        throw driveError(error);
      });
    const now = this.#now();
    this.#db.run(
      `INSERT INTO drive_accounts(user_id, email, name, sealed_token, status, connected_at, updated_at)
       VALUES (?, ?, ?, ?, 'connected', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, name = excluded.name,
         sealed_token = excluded.sealed_token, status = 'connected', connected_at = excluded.connected_at,
         updated_at = excluded.updated_at`,
      userId,
      (about.user?.emailAddress ?? "").slice(0, 254),
      about.user?.displayName?.slice(0, 128) ?? null,
      this.#secrets.seal(tokens.refresh_token, tokenContext(userId)),
      now,
      now,
    );
    this.#quota.delete(userId);
    this.#event("account.connect", actor, "success", { email: about.user?.emailAddress ?? "" });
    return this.account(userId);
  }

  async disconnect(userId: string, actor: Actor): Promise<void> {
    const row = this.#row(userId);
    if (!row) return;
    // Revoking is a courtesy to the person; the token is deleted either way.
    try {
      const token = this.#secrets.open(row.sealed_token, tokenContext(userId));
      const response = await this.#http.request({
        method: "POST",
        url: `${this.#http.endpoints.oauth}/revoke`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        timeoutMs: 10_000,
      });
      response.resume();
    } catch (error) {
      this.#logger.debug("Drive token revocation failed", { error: (error as Error).message });
    }
    this.#db.run("DELETE FROM drive_accounts WHERE user_id = ?", userId);
    this.#tokens.delete(userId);
    this.#quota.delete(userId);
    this.#event("account.disconnect", actor, "success");
  }

  /* --------------------------------- tokens --------------------------------- */

  async #token(userId: string): Promise<string> {
    const cached = this.#tokens.get(userId);
    if (cached && cached.expires - 60_000 > this.#now()) return cached.token;
    const pending = this.#refreshing.get(userId);
    if (pending) return pending;
    const refresh = this.#refresh(userId).finally(() => this.#refreshing.delete(userId));
    this.#refreshing.set(userId, refresh);
    return refresh;
  }

  async #refresh(userId: string): Promise<string> {
    const client = this.#requireClient();
    const row = this.#row(userId);
    if (!row) throw new ApiError(409, "DRIVE_NOT_CONNECTED", "Google Drive is not connected");
    if (row.status === "reconnect")
      throw new ApiError(409, "DRIVE_RECONNECT_REQUIRED", "Connect Google Drive again");
    try {
      const tokens = await this.#http.json<{ access_token?: string; expires_in?: number }>({
        method: "POST",
        url: `${this.#http.endpoints.oauth}/token`,
        form: {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: this.#secrets.open(row.sealed_token, tokenContext(userId)),
          grant_type: "refresh_token",
        },
      });
      if (!tokens.access_token)
        throw new GoogleHttpError("status", "No access token", 400, "invalid_grant");
      this.#tokens.set(userId, {
        token: tokens.access_token,
        expires: this.#now() + Math.max(60, tokens.expires_in ?? 3600) * 1000,
      });
      return tokens.access_token;
    } catch (error) {
      // Revoked, expired (7 days for apps in testing) or issued for another client.
      if (
        error instanceof GoogleHttpError &&
        error.kind === "status" &&
        (error.reason === "invalid_grant" || error.reason === "unauthorized_client")
      ) {
        this.#db.run(
          "UPDATE drive_accounts SET status = 'reconnect', updated_at = ? WHERE user_id = ?",
          this.#now(),
          userId,
        );
        throw new ApiError(409, "DRIVE_RECONNECT_REQUIRED", "Connect Google Drive again");
      }
      throw driveError(error);
    }
  }

  /** A Drive API request with the person's token, retried once after a 401. */
  async #raw(userId: string, input: RawRequest): Promise<IncomingMessage> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#token(userId);
      const response = await this.#http
        .request({
          method: input.method,
          url: input.url ?? `${this.#http.endpoints.api}${input.path}`,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(input.json !== undefined
              ? { "Content-Type": "application/json; charset=utf-8" }
              : {}),
            ...input.headers,
          },
          ...(input.json !== undefined
            ? { body: JSON.stringify(input.json) }
            : input.body
              ? { body: input.body }
              : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        })
        .catch((error: unknown) => {
          throw driveError(error);
        });
      if (response.statusCode === 401 && attempt === 0 && !input.body) {
        response.resume();
        this.#tokens.delete(userId);
        continue;
      }
      return response;
    }
  }

  async #api<T>(userId: string, input: RawRequest): Promise<T> {
    const response = await this.#raw(userId, input);
    const text = await readText(response, 8 * 1024 * 1024).catch((error: unknown) => {
      throw driveError(error);
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw driveError(statusError(status, text));
    return (text ? JSON.parse(text) : {}) as T;
  }

  /* ---------------------------------- files --------------------------------- */

  async metadata(userId: string, id: string): Promise<DriveEntry & { parents: string[] }> {
    const file = await this.#api<RawFile>(userId, {
      method: "GET",
      path: `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(ENTRY_FIELDS)}`,
    });
    return { ...entryOf(file), parents: file.parents ?? [] };
  }

  async list(userId: string, folder: string, pageToken?: string): Promise<DriveListing> {
    const query =
      folder === DRIVE_SHARED
        ? "sharedWithMe = true and trashed = false"
        : `'${folder}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken,files(${ENTRY_FIELDS})`,
      orderBy: "folder,name_natural",
      pageSize: "200",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const [page, path] = await Promise.all([
      this.#api<{ files?: RawFile[]; nextPageToken?: string }>(userId, {
        method: "GET",
        path: `/drive/v3/files?${params.toString()}`,
      }),
      this.#path(userId, folder),
    ]);
    return {
      folder: path.at(-1)!,
      path,
      entries: (page.files ?? []).map(entryOf),
      nextPageToken: page.nextPageToken ?? null,
    };
  }

  /** From My Drive (or Shared with me) down to the folder. */
  async #path(userId: string, folder: string): Promise<Array<{ id: string; name: string }>> {
    if (folder === DRIVE_ROOT) return [{ id: DRIVE_ROOT, name: "My Drive" }];
    if (folder === DRIVE_SHARED) return [{ id: DRIVE_SHARED, name: "Shared with me" }];
    const root = await this.#api<{ id: string }>(userId, {
      method: "GET",
      path: "/drive/v3/files/root?fields=id",
    });
    const chain: Array<{ id: string; name: string }> = [];
    let current: string | undefined = folder;
    for (let depth = 0; current && depth < 24; depth++) {
      if (current === root.id) return [{ id: DRIVE_ROOT, name: "My Drive" }, ...chain.reverse()];
      const file = await this.metadata(userId, current);
      chain.push({ id: file.id, name: file.name });
      current = file.parents[0];
    }
    return [{ id: DRIVE_SHARED, name: "Shared with me" }, ...chain.reverse()];
  }

  async createFolder(userId: string, parent: string, name: string): Promise<DriveEntry> {
    if (parent === DRIVE_SHARED)
      throw new ApiError(400, "VALIDATION_FAILED", "Folders are created in My Drive");
    return entryOf(
      await this.#api<RawFile>(userId, {
        method: "POST",
        path: `/drive/v3/files?supportsAllDrives=true&fields=${encodeURIComponent(ENTRY_FIELDS)}`,
        json: { name, mimeType: DRIVE_FOLDER_MIME, parents: [parent] },
      }),
    );
  }

  async rename(userId: string, id: string, name: string): Promise<DriveEntry> {
    return entryOf(
      await this.#api<RawFile>(userId, {
        method: "PATCH",
        path: `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(ENTRY_FIELDS)}`,
        json: { name },
      }),
    );
  }

  /** Moves to Drive's own trash, where the person can restore it. */
  async trash(userId: string, id: string): Promise<void> {
    await this.#api(userId, {
      method: "PATCH",
      path: `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id`,
      json: { trashed: true },
    });
  }

  /** A file's bytes; Google Docs files are exported in an Office format. */
  async download(userId: string, entry: DriveEntry, signal?: AbortSignal): Promise<DriveDownload> {
    if (entry.folder || !entry.downloadable)
      throw new ApiError(409, "DRIVE_NOT_DOWNLOADABLE", "This file cannot be downloaded");
    const exported = DRIVE_EXPORTS[entry.mimeType];
    const response = await this.#raw(userId, {
      method: "GET",
      path: exported
        ? `/drive/v3/files/${encodeURIComponent(entry.id)}/export?mimeType=${encodeURIComponent(exported.mime)}`
        : `/drive/v3/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`,
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000,
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300)
      throw driveError(statusError(status, await readText(response, 64 * 1024).catch(() => "")));
    const length = Number(response.headers["content-length"]);
    return {
      name: localName(entry),
      sizeBytes: exported ? (Number.isFinite(length) ? length : null) : entry.sizeBytes,
      stream: response,
    };
  }

  /**
   * Streams bytes into a new file of a Drive folder through a resumable upload session, sent in
   * chunks with their own deadline so large files are not bound by one request's timeout.
   */
  async upload(
    userId: string,
    parent: string,
    name: string,
    body: AsyncIterable<Uint8Array>,
    sizeBytes: number,
    signal?: AbortSignal,
    onProgress?: (bytes: number) => void,
  ): Promise<DriveEntry> {
    if (parent === DRIVE_SHARED)
      throw new ApiError(400, "VALIDATION_FAILED", "Files are uploaded to My Drive");
    const session = await this.#raw(userId, {
      method: "POST",
      path: `/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(ENTRY_FIELDS)}`,
      json: { name, parents: [parent] },
      headers: {
        "X-Upload-Content-Length": String(sizeBytes),
        "X-Upload-Content-Type": "application/octet-stream",
      },
      ...(signal ? { signal } : {}),
    });
    const sessionText = await readText(session, 64 * 1024).catch(() => "");
    const location = session.headers.location;
    if ((session.statusCode ?? 0) !== 200 || typeof location !== "string")
      throw driveError(statusError(session.statusCode ?? 0, sessionText));
    if (new URL(location).origin !== new URL(this.#http.endpoints.api).origin)
      throw new ApiError(503, "DRIVE_UNAVAILABLE", "Unexpected upload session");

    /** Sends bytes from `offset`; Google answers 308 with what it has until the last byte. */
    const send = async (chunk: Buffer, offset: number) => {
      const response = await this.#raw(userId, {
        method: "PUT",
        path: "",
        url: location,
        body: chunk,
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Type": "application/octet-stream",
          ...(sizeBytes > 0
            ? { "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${sizeBytes}` }
            : {}),
        },
        ...(signal ? { signal } : {}),
        timeoutMs: 300_000,
      });
      const status = response.statusCode ?? 0;
      const text = await readText(response, 1024 * 1024).catch((error: unknown) => {
        throw driveError(error);
      });
      if (status === 308) {
        const range = /^bytes=0-(\d+)$/.exec(String(response.headers.range ?? ""));
        return { received: range ? Number(range[1]) + 1 : 0, entry: null };
      }
      if (status !== 200 && status !== 201) throw driveError(statusError(status, text));
      return { received: sizeBytes, entry: entryOf(JSON.parse(text) as RawFile) };
    };

    let offset = 0;
    for await (const chunk of rechunk(body, UPLOAD_CHUNK_BYTES)) {
      if (offset + chunk.length > sizeBytes)
        throw new ApiError(400, "VALIDATION_FAILED", "More bytes than announced");
      let sent = 0;
      while (sent < chunk.length) {
        const result = await send(chunk.subarray(sent), offset + sent);
        if (result.entry) {
          if (offset + chunk.length !== sizeBytes)
            throw new ApiError(503, "DRIVE_UNAVAILABLE", "Upload ended early");
          onProgress?.(chunk.length - sent);
          return result.entry;
        }
        if (result.received < offset + sent || result.received > offset + chunk.length)
          throw new ApiError(503, "DRIVE_UNAVAILABLE", "Unexpected upload state");
        onProgress?.(result.received - (offset + sent));
        sent = result.received - offset;
      }
      offset += chunk.length;
    }
    if (offset !== sizeBytes)
      throw new ApiError(400, "VALIDATION_FAILED", "Fewer bytes than announced");
    // Only an empty file gets here: its single request carries no bytes.
    const result = await send(Buffer.alloc(0), 0);
    if (!result.entry) throw new ApiError(503, "DRIVE_UNAVAILABLE", "Upload did not finish");
    return result.entry;
  }

  /** A file or folder directly inside `parent` with exactly this name. */
  async findChild(
    userId: string,
    parent: string,
    name: string,
    folder: boolean,
  ): Promise<DriveEntry | null> {
    const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const params = new URLSearchParams({
      q: `${quote(parent)} in parents and name = ${quote(name)} and trashed = false and mimeType ${folder ? "=" : "!="} '${DRIVE_FOLDER_MIME}'`,
      fields: `files(${ENTRY_FIELDS})`,
      pageSize: "10",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const page = await this.#api<{ files?: RawFile[] }>(userId, {
      method: "GET",
      path: `/drive/v3/files?${params.toString()}`,
    });
    const file = page.files?.[0];
    return file ? entryOf(file) : null;
  }

  /** Deletes a file for good (EveryOS's own backup copies, not the person's files). */
  async remove(userId: string, id: string): Promise<void> {
    const response = await this.#raw(userId, {
      method: "DELETE",
      path: `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
    });
    const text = await readText(response, 64 * 1024).catch(() => "");
    const status = response.statusCode ?? 0;
    if (status !== 204 && status !== 200 && status !== 404)
      throw driveError(statusError(status, text));
  }

  /** Every file below a Drive folder, for copying it out (bounded like local copies). */
  async walk(
    userId: string,
    folder: DriveEntry,
    signal?: AbortSignal,
  ): Promise<Array<{ parent: string; entry: DriveEntry }>> {
    const items: Array<{ parent: string; entry: DriveEntry }> = [];
    const visit = async (id: string, depth: number): Promise<void> => {
      if (depth > 16) throw new ApiError(400, "VALIDATION_FAILED", "The folder is too deep");
      let pageToken: string | undefined;
      do {
        if (signal?.aborted) throw new ApiError(409, "CANCELLED", "Cancelled");
        const params = new URLSearchParams({
          q: `'${id}' in parents and trashed = false`,
          fields: `nextPageToken,files(${ENTRY_FIELDS})`,
          pageSize: "1000",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await this.#api<{ files?: RawFile[]; nextPageToken?: string }>(userId, {
          method: "GET",
          path: `/drive/v3/files?${params.toString()}`,
        });
        for (const file of page.files ?? []) {
          const entry = entryOf(file);
          if (items.length >= 10_000)
            throw new ApiError(400, "VALIDATION_FAILED", "The folder has too many items");
          items.push({ parent: id, entry });
          if (entry.folder) await visit(entry.id, depth + 1);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    };
    await visit(folder.id, 0);
    return items;
  }

  #event(
    action: string,
    actor: Actor,
    outcome: "success" | "failure",
    details: Record<string, string> = {},
  ): void {
    this.#audit.record({
      action: `drive.${action}`,
      outcome,
      ...(actor.kind === "user"
        ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
        : {}),
      details,
    });
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof GoogleHttpError) return error.reason ?? error.kind;
  if (error instanceof ApiError) return error.code;
  return "unknown";
}
