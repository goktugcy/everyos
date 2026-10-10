import { randomUUID } from "node:crypto";
import {
  CatalogError,
  createCatalogFetcher,
  readCatalog,
  type CatalogFetcher,
} from "@otuken/catalogs";
import type { Database } from "@otuken/database";
import { detectAdapters } from "@otuken/widget-sdk";
import type { CatalogApp, CatalogAppView, CatalogFormat, CatalogView } from "@otuken/shared";

interface CatalogRow {
  id: string;
  name: string;
  url: string;
  format: CatalogFormat;
  enabled: number;
  allow_private: number;
  synced_at: number | null;
  snapshot: string | null;
  skipped: string;
  last_error: string | null;
  app_count: number;
}
const CATALOG_SELECT =
  "SELECT catalogs.*, (SELECT count(*) FROM catalog_apps WHERE catalog_id = catalogs.id) AS app_count FROM catalogs";

export class CatalogService {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #fetcher: (allowPrivate: boolean, signal?: AbortSignal) => CatalogFetcher;
  readonly #syncing = new Set<string>();
  readonly #assets = new Map<string, Promise<{ content: Uint8Array; contentType: string }>>();
  readonly #controller = new AbortController();
  #stopped = false;

  constructor(
    db: Database,
    now: () => number,
    fetcher = (allowPrivate: boolean, signal?: AbortSignal) =>
      createCatalogFetcher({ allowPrivate, ...(signal ? { signal } : {}) }),
  ) {
    this.#db = db;
    this.#now = now;
    this.#fetcher = fetcher;
  }
  #view(row: CatalogRow): CatalogView {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      format: row.format,
      enabled: row.enabled === 1,
      allowPrivate: row.allow_private === 1,
      syncedAt: row.synced_at,
      snapshot: row.snapshot,
      appCount: row.app_count,
      skipped: JSON.parse(row.skipped) as CatalogView["skipped"],
      lastError: row.last_error,
    };
  }
  list(): CatalogView[] {
    return this.#db
      .all<CatalogRow>(`${CATALOG_SELECT} ORDER BY name, id`)
      .map((row) => this.#view(row));
  }
  stop(): void {
    this.#stopped = true;
    this.#controller.abort();
  }
  get(id: string): CatalogView | null {
    const row = this.#db.get<CatalogRow>(`${CATALOG_SELECT} WHERE id = ?`, id);
    return row ? this.#view(row) : null;
  }
  create(input: {
    name: string;
    url: string;
    format: CatalogFormat;
    allowPrivate: boolean;
  }): CatalogView {
    const url = new URL(input.url);
    if (
      [...url.searchParams.keys()].some((key) =>
        /token|secret|password|credential|signature|auth|api.?key/i.test(key),
      )
    )
      throw new CatalogError("url-credentials-unsupported");
    if (this.list().length >= 32) throw new CatalogError("too-many-catalogs");
    const id = randomUUID();
    this.#db.run(
      "INSERT INTO catalogs(id, name, url, format, allow_private) VALUES (?, ?, ?, ?, ?)",
      id,
      input.name,
      input.url,
      input.format,
      input.allowPrivate ? 1 : 0,
    );
    const created = this.get(id);
    if (!created) throw new Error("Catalog insertion failed");
    return created;
  }
  update(id: string, enabled: boolean): void {
    if (this.#syncing.has(id)) throw new CatalogError("sync-in-progress");
    this.#db.run("UPDATE catalogs SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
  }
  remove(id: string): void {
    if (this.#syncing.has(id)) throw new CatalogError("sync-in-progress");
    this.#db.run("DELETE FROM catalogs WHERE id = ?", id);
  }
  async sync(id: string, signal?: AbortSignal): Promise<CatalogView> {
    const catalog = this.get(id);
    if (!catalog) throw new CatalogError("catalog-not-found");
    if (!catalog.enabled) throw new CatalogError("catalog-disabled");
    if (this.#syncing.has(id)) throw new CatalogError("sync-in-progress");
    this.#syncing.add(id);
    try {
      const snapshot = await readCatalog({
        catalogId: id,
        url: catalog.url,
        format: catalog.format,
        previous: this.#db
          .all<{ manifest: string }>("SELECT manifest FROM catalog_apps WHERE catalog_id = ?", id)
          .map((row) => JSON.parse(row.manifest) as CatalogApp),
        fetcher: this.#fetcher(
          catalog.allowPrivate,
          signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal,
        ),
      });
      if (this.#stopped) throw new CatalogError("sync-interrupted");
      this.#db.transaction(() => {
        const retained = new Set(snapshot.apps.map((app) => app.id));
        for (const row of this.#db.all<{ id: string }>(
          "SELECT id FROM catalog_apps WHERE catalog_id = ?",
          id,
        ))
          if (!retained.has(row.id)) this.#db.run("DELETE FROM catalog_apps WHERE id = ?", row.id);
        for (const app of snapshot.apps) {
          const prior = this.#db.get<{ manifest: string }>(
            "SELECT manifest FROM catalog_apps WHERE id = ?",
            app.id,
          );
          if (prior && (JSON.parse(prior.manifest) as CatalogApp).icon !== app.icon)
            this.#db.run("DELETE FROM catalog_assets WHERE app_id = ?", app.id);
          this.#db.run(
            "INSERT INTO catalog_apps(id, catalog_id, logical_key, manifest) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET logical_key = excluded.logical_key, manifest = excluded.manifest",
            app.id,
            id,
            app.logicalKey,
            JSON.stringify(app),
          );
        }
        this.#db.run(
          "UPDATE catalogs SET synced_at = ?, snapshot = ?, skipped = ?, last_error = NULL WHERE id = ?",
          this.#now(),
          snapshot.ref,
          JSON.stringify(snapshot.skipped),
          id,
        );
      });
      return this.get(id) ?? catalog;
    } catch (error) {
      const reason = error instanceof CatalogError ? error.reason : "sync-failed";
      if (!this.#stopped)
        this.#db.run("UPDATE catalogs SET last_error = ? WHERE id = ?", reason, id);
      throw new CatalogError(reason);
    } finally {
      this.#syncing.delete(id);
    }
  }
  apps(): CatalogAppView[] {
    const apps = this.#db
      .all<{ manifest: string }>(
        "SELECT manifest FROM catalog_apps JOIN catalogs ON catalog_apps.catalog_id = catalogs.id WHERE catalogs.enabled = 1 ORDER BY catalog_apps.id",
      )
      .map((row) => JSON.parse(row.manifest) as CatalogApp);
    const groups = new Map<string, string[]>();
    for (const app of apps)
      groups.set(app.logicalKey, [...(groups.get(app.logicalKey) ?? []), app.id]);
    return apps.map((app) => {
      const { compose: _compose, variants: _variants, ...view } = app;
      return {
        ...view,
        links: app.links ?? { documentation: null, website: null, repository: null },
        notes: app.notes ?? {},
        web: app.web ?? { path: "/", scheme: "http" },
        contentHash: app.contentHash ?? null,
        icon: app.icon ? `/api/catalogs/apps/${encodeURIComponent(app.id)}/icon` : null,
        screenshots: (app.screenshots ?? []).map(
          (_, index) => `/api/catalogs/apps/${encodeURIComponent(app.id)}/screenshots/${index}`,
        ),
        variables: app.variables.map((entry) => ({
          ...entry,
          required: entry.required || (entry.secret && !entry.generated && !!entry.default),
          default: entry.secret ? null : entry.default,
        })),
        duplicates: (groups.get(app.logicalKey) ?? []).filter((id) => id !== app.id),
        widgetAdapters: detectAdapters(app.images),
      };
    });
  }
  app(id: string): CatalogApp | null {
    const row = this.#db.get<{ manifest: string }>(
      "SELECT manifest FROM catalog_apps JOIN catalogs ON catalog_apps.catalog_id = catalogs.id WHERE catalog_apps.id = ? AND catalogs.enabled = 1",
      id,
    );
    return row ? (JSON.parse(row.manifest) as CatalogApp) : null;
  }
  async icon(id: string): Promise<{ content: Uint8Array; contentType: string }> {
    const cached = this.#db.get<{ content: Uint8Array; content_type: string }>(
      "SELECT content, content_type FROM catalog_assets WHERE app_id = ?",
      id,
    );
    if (cached) return { content: cached.content, contentType: cached.content_type };
    const existing = this.#assets.get(id);
    if (existing) return existing;
    const app = this.app(id);
    const catalog = app ? this.get(app.source.catalogId) : null;
    if (!app?.icon || !catalog) throw new CatalogError("asset-unavailable");
    const load = (async () => {
      const content = await this.#fetcher(catalog.allowPrivate, this.#controller.signal).get(
        app.icon ?? "",
        512 * 1024,
      );
      if (this.#stopped) throw new CatalogError("asset-unavailable");
      const contentType = content
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : content[0] === 255 && content[1] === 216 && content[2] === 255
          ? "image/jpeg"
          : content.subarray(0, 4).toString() === "RIFF" &&
              content.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : null;
      if (!contentType) throw new CatalogError("unsupported-asset");
      // A sync may have removed this app while the asset was being fetched.
      if (this.app(id)?.icon === app.icon)
        this.#db.run(
          "INSERT OR REPLACE INTO catalog_assets(app_id, content, content_type) VALUES (?, ?, ?)",
          id,
          content,
          contentType,
        );
      return { content, contentType };
    })().finally(() => this.#assets.delete(id));
    this.#assets.set(id, load);
    return load;
  }
  async screenshot(
    id: string,
    index: number,
  ): Promise<{ content: Uint8Array; contentType: string }> {
    const app = this.app(id),
      catalog = app ? this.get(app.source.catalogId) : null;
    const url = app?.screenshots?.[index];
    if (!url || !catalog) throw new CatalogError("asset-unavailable");
    const cached = this.#db.get<{ url: string; content: Uint8Array; content_type: string }>(
      "SELECT url, content, content_type FROM catalog_media WHERE app_id = ? AND position = ?",
      id,
      index,
    );
    if (cached?.url === url) return { content: cached.content, contentType: cached.content_type };
    const content = await this.#fetcher(catalog.allowPrivate, this.#controller.signal).get(
      url,
      2 * 1024 * 1024,
    );
    const contentType = content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : content[0] === 255 && content[1] === 216 && content[2] === 255
        ? "image/jpeg"
        : content.subarray(0, 4).toString() === "RIFF" &&
            content.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : null;
    if (!contentType || this.#stopped) throw new CatalogError("unsupported-asset");
    if (this.app(id)?.screenshots?.[index] === url)
      this.#db.run(
        "INSERT OR REPLACE INTO catalog_media (app_id, position, url, content, content_type) VALUES (?, ?, ?, ?, ?)",
        id,
        index,
        url,
        content,
        contentType,
      );
    return { content, contentType };
  }
}
