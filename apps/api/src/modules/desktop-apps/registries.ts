import { randomUUID } from "node:crypto";
import { keyFingerprint } from "@everyos/app-package";
import { RegistryError, verifyRegistryIndex, type RegistryIndex } from "@everyos/app-registry";
import { CatalogError, createCatalogFetcher, type CatalogFetcher } from "@everyos/catalogs";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import {
  MAX_DESKTOP_APP_REGISTRIES,
  type DesktopAppRegistryKind,
  type DesktopAppRegistryView,
} from "@everyos/shared";
import { ApiError, notFound } from "../../http/errors.ts";
import type { RegistryAnchor } from "./anchors.ts";

interface RegistryRow {
  id: string;
  kind: DesktopAppRegistryKind;
  name: string;
  url: string;
  public_key: string;
  fingerprint: string;
  sealed_token: string | null;
  allow_private: number;
  enabled: number;
  sequence: number;
  index_json: string | null;
  synced_at: number | null;
  last_error: string | null;
}

export interface RegistryRecord {
  id: string;
  kind: DesktopAppRegistryKind;
  name: string;
  url: string;
  publicKey: string;
  enabled: boolean;
  allowPrivate: boolean;
  /** The last verified index, or null before the first successful sync. */
  index: RegistryIndex | null;
}

export type FetcherFactory = (options: {
  allowPrivate: boolean;
  authorization?: { origin: string; value: string };
  maxTotalBytes: number;
  deadlineMs: number;
  signal?: AbortSignal;
}) => CatalogFetcher;

const TOKEN_CONTEXT = (id: string) => `everyos/desktop-app-registry-token/${id}`;
const INDEX_FETCH_BYTES = 12 * 1024 * 1024;

export const registryFailed = (reason: string) =>
  new ApiError(502, "DESKTOP_APP_REGISTRY_FAILED", "The app registry could not be used", {
    details: { reason },
  });

/**
 * Desktop app registries: the built-in official and community ones (anchored in configuration),
 * and those an administrator adds. Sync fetches the signed index SSRF-safely and keeps it only
 * after full verification, never accepting a lower sequence than before.
 */
export class DesktopAppRegistries {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #fetcher: FetcherFactory;
  readonly #anchors: { official: RegistryAnchor | null; community: RegistryAnchor | null };
  readonly #syncing = new Set<string>();

  constructor(options: {
    db: Database;
    secrets: SecretBox;
    logger: Logger;
    now: () => number;
    anchors: { official: RegistryAnchor | null; community: RegistryAnchor | null };
    fetcher?: FetcherFactory;
  }) {
    this.#db = options.db;
    this.#secrets = options.secrets;
    this.#logger = options.logger.child({ component: "desktop-app-registries" });
    this.#now = options.now;
    this.#anchors = options.anchors;
    this.#fetcher =
      options.fetcher ??
      ((fetchOptions) => createCatalogFetcher({ ...fetchOptions, userAgent: "EveryOS-Apps/1" }));
  }

  /** Keeps the built-in registries in line with their anchors; a changed key starts trust anew. */
  ensureBuiltIns(): void {
    const builtIns: Array<
      [string, DesktopAppRegistryKind, string, RegistryAnchor | null, boolean]
    > = [
      ["official", "official", "EveryOS", this.#anchors.official, true],
      ["community", "community", "EveryOS Community", this.#anchors.community, false],
    ];
    for (const [id, kind, name, anchor, enabled] of builtIns) {
      const row = this.#db.get<RegistryRow>(
        "SELECT * FROM desktop_app_registries WHERE id = ?",
        id,
      );
      if (!anchor) {
        if (row) this.#db.run("DELETE FROM desktop_app_registries WHERE id = ?", id);
        continue;
      }
      const fingerprint = keyFingerprint(anchor.publicKey);
      const now = this.#now();
      if (!row)
        this.#db.run(
          `INSERT INTO desktop_app_registries(id, kind, name, url, public_key, fingerprint, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          kind,
          name,
          anchor.url,
          anchor.publicKey,
          fingerprint,
          enabled ? 1 : 0,
          now,
          now,
        );
      else if (row.url !== anchor.url || row.fingerprint !== fingerprint)
        this.#db.run(
          `UPDATE desktop_app_registries SET url = ?, public_key = ?, fingerprint = ?, sequence = -1,
           index_json = NULL, synced_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
          anchor.url,
          anchor.publicKey,
          fingerprint,
          now,
          id,
        );
    }
  }

  #record(row: RegistryRow): RegistryRecord {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      url: row.url,
      publicKey: row.public_key,
      enabled: row.enabled === 1,
      allowPrivate: row.allow_private === 1,
      index: row.index_json ? (JSON.parse(row.index_json) as RegistryIndex) : null,
    };
  }

  #view(row: RegistryRow): DesktopAppRegistryView {
    const index = row.index_json ? (JSON.parse(row.index_json) as RegistryIndex) : null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      url: row.url,
      fingerprint: row.fingerprint,
      enabled: row.enabled === 1,
      allowPrivate: row.allow_private === 1,
      hasToken: row.sealed_token !== null,
      syncedAt: row.synced_at,
      sequence: index ? index.sequence : null,
      expiresAt: index ? index.expiresAt : null,
      appCount: index ? index.apps.length : 0,
      lastError: row.last_error,
    };
  }

  #row(id: string): RegistryRow {
    const row = this.#db.get<RegistryRow>("SELECT * FROM desktop_app_registries WHERE id = ?", id);
    if (!row) throw notFound("Registry");
    return row;
  }

  list(): DesktopAppRegistryView[] {
    return this.#db
      .all<RegistryRow>(
        "SELECT * FROM desktop_app_registries ORDER BY CASE kind WHEN 'official' THEN 0 WHEN 'community' THEN 1 ELSE 2 END, name, id",
      )
      .map((row) => this.#view(row));
  }

  view(id: string): DesktopAppRegistryView {
    return this.#view(this.#row(id));
  }

  record(id: string): RegistryRecord | null {
    const row = this.#db.get<RegistryRow>("SELECT * FROM desktop_app_registries WHERE id = ?", id);
    return row ? this.#record(row) : null;
  }

  /** Enabled registries with a verified index that has not expired. */
  usable(): RegistryRecord[] {
    const now = this.#now();
    return this.#db
      .all<RegistryRow>(
        "SELECT * FROM desktop_app_registries WHERE enabled = 1 AND index_json IS NOT NULL",
      )
      .map((row) => this.#record(row))
      .filter((record) => record.index !== null && record.index.expiresAt > now);
  }

  create(input: {
    kind: "community" | "private";
    name: string;
    url: string;
    publicKey: string;
    fingerprint: string;
    token?: string | undefined;
    allowPrivate: boolean;
  }): DesktopAppRegistryView {
    let fingerprint: string;
    try {
      fingerprint = keyFingerprint(input.publicKey);
    } catch {
      throw new ApiError(400, "VALIDATION_FAILED", "The registry key is not an Ed25519 public key");
    }
    // The administrator confirms the key they paste by its fingerprint, as the publisher shows it.
    if (fingerprint !== input.fingerprint)
      throw new ApiError(400, "VALIDATION_FAILED", "The fingerprint does not match the key");
    if (this.list().length >= MAX_DESKTOP_APP_REGISTRIES)
      throw new ApiError(409, "CONFLICT", "Too many registries");
    if (this.#db.get("SELECT 1 FROM desktop_app_registries WHERE url = ?", input.url))
      throw new ApiError(409, "CONFLICT", "This registry is already added");
    const id = `r-${randomUUID()}`;
    const now = this.#now();
    this.#db.run(
      `INSERT INTO desktop_app_registries(id, kind, name, url, public_key, fingerprint, sealed_token, allow_private, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.name,
      input.url,
      input.publicKey.trim() + "\n",
      fingerprint,
      input.token ? this.#secrets.seal(input.token, TOKEN_CONTEXT(id)) : null,
      input.allowPrivate ? 1 : 0,
      now,
      now,
    );
    return this.view(id);
  }

  update(id: string, input: { enabled?: boolean | undefined; token?: string | null | undefined }) {
    const row = this.#row(id);
    if (input.token !== undefined && row.kind !== "private")
      throw new ApiError(400, "VALIDATION_FAILED", "Only private registries take a token");
    if (this.#syncing.has(id)) throw new ApiError(409, "CONFLICT", "The registry is syncing");
    this.#db.run(
      `UPDATE desktop_app_registries SET enabled = ?, sealed_token = ?, updated_at = ? WHERE id = ?`,
      input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      input.token === undefined
        ? row.sealed_token
        : input.token === null
          ? null
          : this.#secrets.seal(input.token, TOKEN_CONTEXT(id)),
      this.#now(),
      id,
    );
    return this.view(id);
  }

  remove(id: string): void {
    const row = this.#row(id);
    if (row.kind === "official" || row.id === "community")
      throw new ApiError(400, "VALIDATION_FAILED", "Built-in registries can only be disabled");
    if (this.#syncing.has(id)) throw new ApiError(409, "CONFLICT", "The registry is syncing");
    this.#db.run("DELETE FROM desktop_app_registries WHERE id = ?", id);
  }

  /** A fetcher for the registry's own resources (index, icons, packages), with its credential. */
  fetcherFor(
    record: Pick<RegistryRecord, "id" | "url" | "allowPrivate">,
    limits: { maxTotalBytes: number; deadlineMs: number; signal?: AbortSignal | undefined },
  ): CatalogFetcher {
    const row = this.#row(record.id);
    const token = row.sealed_token
      ? this.#secrets.open(row.sealed_token, TOKEN_CONTEXT(record.id))
      : null;
    return this.#fetcher({
      allowPrivate: record.allowPrivate,
      ...(token
        ? { authorization: { origin: new URL(record.url).origin, value: `Bearer ${token}` } }
        : {}),
      maxTotalBytes: limits.maxTotalBytes,
      deadlineMs: limits.deadlineMs,
      ...(limits.signal ? { signal: limits.signal } : {}),
    });
  }

  /** Absolute URL of a resource the index names (relative paths resolve against the index URL). */
  static resolve(registryUrl: string, resource: string): string {
    return new URL(resource, registryUrl).href;
  }

  async sync(id: string, signal?: AbortSignal): Promise<DesktopAppRegistryView> {
    const row = this.#row(id);
    if (row.enabled !== 1) throw new ApiError(409, "CONFLICT", "The registry is disabled");
    if (this.#syncing.has(id)) throw new ApiError(409, "CONFLICT", "The registry is syncing");
    this.#syncing.add(id);
    try {
      const fetcher = this.fetcherFor(
        { id, url: row.url, allowPrivate: row.allow_private === 1 },
        { maxTotalBytes: INDEX_FETCH_BYTES, deadlineMs: 60_000, signal },
      );
      const text = (await fetcher.get(row.url, INDEX_FETCH_BYTES)).toString("utf8");
      const index = verifyRegistryIndex(text, row.public_key, {
        official: row.kind === "official",
        now: this.#now(),
        ...(row.sequence >= 0 ? { minSequence: row.sequence } : {}),
      });
      this.#db.run(
        `UPDATE desktop_app_registries SET sequence = ?, index_json = ?, synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        index.sequence,
        JSON.stringify(index),
        this.#now(),
        this.#now(),
        id,
      );
      return this.view(id);
    } catch (error) {
      const reason =
        error instanceof RegistryError
          ? error.code
          : error instanceof CatalogError
            ? error.reason
            : "failed";
      this.#db.run(
        "UPDATE desktop_app_registries SET last_error = ?, updated_at = ? WHERE id = ?",
        reason,
        this.#now(),
        id,
      );
      this.#logger.warn("Desktop app registry sync failed", { registry: id, reason });
      throw registryFailed(reason);
    } finally {
      this.#syncing.delete(id);
    }
  }

  /** Syncs every enabled registry; failures are recorded on each registry, not thrown. */
  async syncAll(signal?: AbortSignal): Promise<void> {
    for (const row of this.#db.all<{ id: string }>(
      "SELECT id FROM desktop_app_registries WHERE enabled = 1",
    ))
      await this.sync(row.id, signal).catch(() => undefined);
  }
}
