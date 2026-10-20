import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_SDK_VERSION,
  capabilityInfo,
  checkCompatibility,
  compareVersions,
  type AppCapability,
  type AppManifest,
} from "@everyos/app-manifest";
import { extractPackage, PackageError, sha256Hex, verifyPackage } from "@everyos/app-package";
import {
  latestVersion,
  revocationOf,
  type RegistryApp,
  type RegistryIndex,
  type RegistryVersion,
} from "@everyos/app-registry";
import { CatalogError } from "@everyos/catalogs";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import {
  EVERYOS_VERSION,
  type DesktopAppInstallationView,
  type DesktopAppListing,
  type DesktopAppRegistryKind,
  type DesktopAppState,
  type Permission,
} from "@everyos/shared";
import { ApiError, forbidden, notFound } from "../../http/errors.ts";
import { DesktopAppRegistries, registryFailed, type RegistryRecord } from "./registries.ts";

interface InstallationRow {
  app_id: string;
  registry_id: string | null;
  version: string;
  manifest_json: string;
  sha256: string;
  size: number;
  signature: string;
  publisher_key: string;
  runtime_key: string;
  granted: string;
  state: DesktopAppState;
  state_reason: string | null;
  previous_version: string | null;
  installed_at: number;
  updated_at: number;
}

export interface InstallActor {
  userId: string;
  permissions: ReadonlySet<Permission>;
}

const busy = () =>
  new ApiError(409, "DESKTOP_APP_BUSY", "Another operation is running for this app");
export const packageInvalid = (reason: string) =>
  new ApiError(502, "DESKTOP_APP_PACKAGE_INVALID", "The app package could not be verified", {
    details: { reason },
  });

/** Key-sorted JSON, so two equal manifests compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Installs, updates and removes desktop apps. A version becomes visible only after its package was
 * downloaded, matched to the registry's size, digest and publisher signature, unpacked with limits,
 * found to carry exactly the manifest the registry listed (and that was approved), and moved into
 * place; the database row comes last. A failed step leaves the previous state untouched.
 */
export class DesktopAppInstaller {
  readonly #db: Database;
  readonly #registries: DesktopAppRegistries;
  readonly #dir: string;
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #busy = new Set<string>();

  constructor(options: {
    db: Database;
    registries: DesktopAppRegistries;
    dir: string;
    now: () => number;
    logger: Logger;
  }) {
    this.#db = options.db;
    this.#registries = options.registries;
    this.#dir = options.dir;
    this.#now = options.now;
    this.#logger = options.logger.child({ component: "desktop-app-installer" });
  }

  #rows(): InstallationRow[] {
    return this.#db.all<InstallationRow>("SELECT * FROM desktop_app_installations ORDER BY app_id");
  }

  #row(appId: string): InstallationRow | null {
    return (
      this.#db.get<InstallationRow>(
        "SELECT * FROM desktop_app_installations WHERE app_id = ?",
        appId,
      ) ?? null
    );
  }

  #compatibility(manifest: AppManifest) {
    const result = checkCompatibility(manifest, {
      everyosVersion: EVERYOS_VERSION,
      sdkVersion: APP_SDK_VERSION,
    });
    return result.ok ? null : result.reason;
  }

  /* ------------------------------------------------------------------ views */

  #installationView(row: InstallationRow): DesktopAppInstallationView {
    const manifest = JSON.parse(row.manifest_json) as AppManifest;
    const granted = new Set(JSON.parse(row.granted) as string[]);
    const registry = row.registry_id ? this.#registries.record(row.registry_id) : null;
    return {
      appId: row.app_id,
      version: row.version,
      name: manifest.name,
      description: manifest.description,
      category: manifest.category,
      registry: registry ? { id: registry.id, name: registry.name, kind: registry.kind } : null,
      publisher: { id: manifest.publisher.id, name: manifest.publisher.name },
      runtimeUrl: `/app-runtime/${row.runtime_key}/`,
      entry: manifest.entry,
      icon: manifest.icon,
      window: manifest.window,
      widgets: manifest.widgets,
      locales: manifest.locales ?? null,
      permissions: manifest.permissions.map((capability) => ({
        capability,
        risk: capabilityInfo(capability).risk,
        granted: granted.has(capability),
      })),
      state: row.state,
      stateReason: row.state_reason,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    };
  }

  installations(): DesktopAppInstallationView[] {
    return this.#rows().map((row) => this.#installationView(row));
  }

  installation(appId: string): DesktopAppInstallationView | null {
    const row = this.#row(appId);
    return row ? this.#installationView(row) : null;
  }

  /** The running manifest and grants of an active app (what SDK calls are checked against). */
  active(appId: string): { manifest: AppManifest; granted: ReadonlySet<string> } | null {
    const row = this.#row(appId);
    if (!row || row.state !== "active") return null;
    return {
      manifest: JSON.parse(row.manifest_json) as AppManifest,
      granted: new Set(JSON.parse(row.granted) as string[]),
    };
  }

  /** The directory of an active app's files for a runtime key, or null. */
  runtimeDirectory(runtimeKey: string): { appId: string; dir: string } | null {
    if (!/^[a-f0-9]{32}$/.test(runtimeKey)) return null;
    const row = this.#db.get<{ app_id: string; version: string; state: string }>(
      "SELECT app_id, version, state FROM desktop_app_installations WHERE runtime_key = ?",
      runtimeKey,
    );
    if (!row || row.state !== "active") return null;
    return { appId: row.app_id, dir: join(this.#dir, "apps", row.app_id, row.version) };
  }

  /** Every app the usable registries offer, with its install and update state. */
  listings(): DesktopAppListing[] {
    const installed = new Map(this.#rows().map((row) => [row.app_id, row]));
    const registries = this.#registries.usable();
    const keysByApp = new Map<string, Set<string>>();
    for (const registry of registries)
      for (const app of registry.index!.apps) {
        const keys = registry.index!.publishers.find((p) => p.id === app.publisher)?.keys ?? [];
        const set = keysByApp.get(app.id) ?? new Set<string>();
        set.add([...keys].sort().join("|"));
        keysByApp.set(app.id, set);
      }
    const listings: DesktopAppListing[] = [];
    for (const registry of registries) {
      const index = registry.index!;
      for (const app of index.apps) {
        const latest = latestVersion(index, app);
        const shown =
          latest ?? [...app.versions].sort((a, b) => compareVersions(b.version, a.version))[0]!;
        const publisher = index.publishers.find((p) => p.id === app.publisher)!;
        const row = installed.get(app.id);
        const compatible = app.versions
          .filter(
            (entry) =>
              !entry.version.includes("-") &&
              !revocationOf(index, app.id, entry.version) &&
              !this.#compatibility(entry.manifest),
          )
          .sort((a, b) => compareVersions(b.version, a.version))[0];
        listings.push({
          appId: app.id,
          registry: { id: registry.id, name: registry.name, kind: registry.kind },
          publisher: { id: publisher.id, name: publisher.name, url: publisher.url ?? null },
          name: shown.manifest.name,
          description: shown.manifest.description,
          category: shown.manifest.category,
          version: shown.version,
          license: shown.manifest.license ?? null,
          homepage: shown.manifest.homepage ?? null,
          source: shown.manifest.source ?? null,
          permissions: shown.manifest.permissions.map((capability) => ({
            capability,
            risk: capabilityInfo(capability).risk,
          })),
          widgets: shown.manifest.widgets.length,
          locales: shown.manifest.locales?.supported ?? ["en"],
          versions: [...app.versions]
            .sort((a, b) => compareVersions(b.version, a.version))
            .map((entry) => ({
              version: entry.version,
              publishedAt: entry.publishedAt,
              changelog: entry.changelog ?? null,
            })),
          screenshots: app.screenshots.length,
          incompatible: this.#compatibility(shown.manifest),
          revoked: latest ? null : (revocationOf(index, app.id, shown.version)?.reason ?? null),
          conflict: (keysByApp.get(app.id)?.size ?? 0) > 1,
          installed: row
            ? { version: row.version, state: row.state, registryId: row.registry_id }
            : null,
          updateAvailable:
            row &&
            row.registry_id === registry.id &&
            compatible &&
            compareVersions(compatible.version, row.version) > 0
              ? compatible.version
              : null,
        });
      }
    }
    return listings.sort(
      (a, b) => a.name.localeCompare(b.name) || a.registry.id.localeCompare(b.registry.id),
    );
  }

  /** An app entry of a usable registry, with the registry record. */
  listing(registryId: string, appId: string): { registry: RegistryRecord; app: RegistryApp } {
    const registry = this.#registries.usable().find((record) => record.id === registryId);
    if (!registry) throw notFound("Registry");
    const app = registry.index!.apps.find((entry) => entry.id === appId);
    if (!app) throw notFound("App");
    return { registry, app };
  }

  /* ------------------------------------------------------------- operations */

  #choose(index: RegistryIndex, app: RegistryApp, version: string | undefined): RegistryVersion {
    const entry = version
      ? app.versions.find((candidate) => candidate.version === version)
      : app.versions
          .filter(
            (candidate) =>
              !candidate.version.includes("-") &&
              !revocationOf(index, app.id, candidate.version) &&
              !this.#compatibility(candidate.manifest),
          )
          .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!entry) {
      if (version) throw notFound("Version");
      throw new ApiError(409, "DESKTOP_APP_INCOMPATIBLE", "No compatible version", {
        details: { reason: "no-compatible-version" },
      });
    }
    const revoked = revocationOf(index, app.id, entry.version);
    if (revoked)
      throw new ApiError(409, "DESKTOP_APP_REVOKED", "This version was revoked", {
        details: { reason: revoked.reason },
      });
    const incompatible = this.#compatibility(entry.manifest);
    if (incompatible)
      throw new ApiError(409, "DESKTOP_APP_INCOMPATIBLE", "The app is not compatible", {
        details: { reason: incompatible },
      });
    return entry;
  }

  /**
   * The capabilities to grant: standard ones always, others when granted before or approved now.
   * Elevated capabilities need an administrator (settings:manage).
   */
  #grants(
    manifest: AppManifest,
    previous: ReadonlySet<string>,
    approve: readonly string[],
    actor: InstallActor,
  ): AppCapability[] {
    const missing = { sensitive: [] as string[], elevated: [] as string[] };
    for (const capability of manifest.permissions) {
      const { risk } = capabilityInfo(capability);
      if (risk === "standard" || previous.has(capability)) continue;
      if (!approve.includes(capability)) missing[risk].push(capability);
      else if (risk === "elevated" && !actor.permissions.has("settings:manage")) throw forbidden();
    }
    if (missing.sensitive.length || missing.elevated.length)
      throw new ApiError(409, "DESKTOP_APP_APPROVAL_REQUIRED", "Permissions need approval", {
        details: missing,
      });
    return manifest.permissions;
  }

  async #download(
    registry: RegistryRecord,
    app: RegistryApp,
    entry: RegistryVersion,
  ): Promise<{ bytes: Buffer; publisherKey: string }> {
    const fetcher = this.#registries.fetcherFor(registry, {
      maxTotalBytes: entry.package.size + 64 * 1024,
      deadlineMs: 10 * 60_000,
    });
    let bytes: Buffer;
    try {
      bytes = await fetcher.get(
        DesktopAppRegistries.resolve(registry.url, entry.package.url),
        entry.package.size,
      );
    } catch (error) {
      // More bytes than the signed size is the package's fault, not the registry's.
      if (error instanceof CatalogError && error.reason === "too-large")
        throw packageInvalid("size");
      throw registryFailed(`download: ${error instanceof CatalogError ? error.reason : "failed"}`);
    }
    if (bytes.length !== entry.package.size || sha256Hex(bytes) !== entry.package.sha256)
      throw packageInvalid("digest");
    const digest = {
      appId: app.id,
      version: entry.version,
      sha256: entry.package.sha256,
      size: entry.package.size,
    };
    const publisher = registry.index!.publishers.find((p) => p.id === app.publisher);
    const publisherKey = publisher?.keys.find((key) =>
      verifyPackage(digest, entry.package.signature, key),
    );
    if (!publisherKey) throw packageInvalid("signature");
    return { bytes, publisherKey };
  }

  /** Unpacks into the version's directory via a staging directory; returns nothing until done. */
  async #unpack(appId: string, entry: RegistryVersion, bytes: Buffer): Promise<void> {
    const staging = join(this.#dir, "staging", randomUUID());
    await mkdir(join(this.#dir, "staging"), { recursive: true, mode: 0o750 });
    let manifest: AppManifest;
    try {
      ({ manifest } = await extractPackage(bytes, staging));
    } catch (error) {
      if (error instanceof PackageError) throw packageInvalid(error.code);
      throw error;
    }
    // What runs must be exactly what the registry listed and what was approved.
    if (canonical(manifest) !== canonical(entry.manifest)) {
      await rm(staging, { recursive: true, force: true });
      throw packageInvalid("manifest-mismatch");
    }
    const target = join(this.#dir, "apps", appId, entry.version);
    await mkdir(join(this.#dir, "apps", appId), { recursive: true, mode: 0o755 });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const packages = join(this.#dir, "packages");
    await mkdir(packages, { recursive: true, mode: 0o750 });
    const file = join(packages, `${appId}@${entry.version}.eosapp`);
    await writeFile(`${file}.part`, bytes, { mode: 0o640 });
    await rename(`${file}.part`, file);
  }

  async #exclusive<T>(appId: string, run: () => Promise<T>): Promise<T> {
    if (this.#busy.has(appId)) throw busy();
    this.#busy.add(appId);
    try {
      return await run();
    } finally {
      this.#busy.delete(appId);
    }
  }

  async install(
    input: { registryId: string; appId: string; version?: string | undefined; approve: string[] },
    actor: InstallActor,
  ): Promise<DesktopAppInstallationView> {
    return this.#exclusive(input.appId, async () => {
      if (this.#row(input.appId))
        throw new ApiError(409, "CONFLICT", "The app is already installed");
      const { registry, app } = this.listing(input.registryId, input.appId);
      const entry = this.#choose(registry.index!, app, input.version);
      const granted = this.#grants(entry.manifest, new Set(), input.approve, actor);
      const { bytes, publisherKey } = await this.#download(registry, app, entry);
      await this.#unpack(app.id, entry, bytes);
      const now = this.#now();
      try {
        this.#db.run(
          `INSERT INTO desktop_app_installations(app_id, registry_id, version, manifest_json, sha256, size, signature,
             publisher_key, runtime_key, granted, state, installed_by, installed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          app.id,
          registry.id,
          entry.version,
          JSON.stringify(entry.manifest),
          entry.package.sha256,
          entry.package.size,
          entry.package.signature,
          publisherKey,
          randomBytes(16).toString("hex"),
          JSON.stringify(granted),
          actor.userId,
          now,
          now,
        );
      } catch (error) {
        await this.#removeFiles(app.id);
        throw error;
      }
      this.#logger.info("Desktop app installed", { app: app.id, version: entry.version });
      return this.installation(app.id)!;
    });
  }

  async update(
    appId: string,
    input: { version?: string | undefined; approve: string[] },
    actor: InstallActor,
  ): Promise<DesktopAppInstallationView> {
    return this.#exclusive(appId, async () => {
      const row = this.#row(appId);
      if (!row) throw notFound("App");
      if (!row.registry_id)
        throw new ApiError(409, "CONFLICT", "The registry of this app was removed");
      const { registry, app } = this.listing(row.registry_id, appId);
      const entry = this.#choose(registry.index!, app, input.version);
      if (compareVersions(entry.version, row.version) <= 0)
        throw new ApiError(409, "CONFLICT", "Not a newer version");
      const previous = new Set(JSON.parse(row.granted) as string[]);
      const granted = this.#grants(entry.manifest, previous, input.approve, actor);
      const { bytes, publisherKey } = await this.#download(registry, app, entry);
      await this.#unpack(appId, entry, bytes);
      this.#db.run(
        `UPDATE desktop_app_installations SET version = ?, manifest_json = ?, sha256 = ?, size = ?, signature = ?,
           publisher_key = ?, runtime_key = ?, granted = ?, state = 'active', state_reason = NULL,
           previous_version = ?, updated_at = ? WHERE app_id = ?`,
        entry.version,
        JSON.stringify(entry.manifest),
        entry.package.sha256,
        entry.package.size,
        entry.package.signature,
        publisherKey,
        randomBytes(16).toString("hex"),
        JSON.stringify(granted),
        row.version,
        this.#now(),
        appId,
      );
      // The new version is active; the old files can go.
      await rm(join(this.#dir, "apps", appId, row.version), { recursive: true, force: true });
      await rm(join(this.#dir, "packages", `${appId}@${row.version}.eosapp`), { force: true });
      this.#logger.info("Desktop app updated", {
        app: appId,
        from: row.version,
        to: entry.version,
      });
      return this.installation(appId)!;
    });
  }

  setEnabled(appId: string, enabled: boolean): DesktopAppInstallationView {
    const row = this.#row(appId);
    if (!row) throw notFound("App");
    if (row.state === "revoked" && enabled)
      throw new ApiError(409, "DESKTOP_APP_REVOKED", "This version was revoked", {
        details: { reason: row.state_reason },
      });
    if (row.state !== "revoked")
      this.#db.run(
        "UPDATE desktop_app_installations SET state = ?, state_reason = NULL, updated_at = ? WHERE app_id = ?",
        enabled ? "active" : "disabled",
        this.#now(),
        appId,
      );
    return this.installation(appId)!;
  }

  async #removeFiles(appId: string): Promise<void> {
    await rm(join(this.#dir, "apps", appId), { recursive: true, force: true });
    const packages = join(this.#dir, "packages");
    for (const name of await readdir(packages).catch(() => [] as string[]))
      if (name.startsWith(`${appId}@`)) await rm(join(packages, name), { force: true });
  }

  /** Removes the app with everyone's data, grants and settings for it. */
  async uninstall(appId: string): Promise<void> {
    await this.#exclusive(appId, async () => {
      if (!this.#row(appId)) throw notFound("App");
      this.#db.run("DELETE FROM desktop_app_installations WHERE app_id = ?", appId);
      await this.#removeFiles(appId);
      this.#logger.info("Desktop app uninstalled", { app: appId });
    });
  }

  /** Marks installed versions their registry revoked (and lifts lifted revocations). */
  applyRevocations(): string[] {
    const changed: string[] = [];
    for (const row of this.#rows()) {
      if (!row.registry_id) continue;
      const index = this.#registries.record(row.registry_id)?.index;
      if (!index) continue;
      const revoked = revocationOf(index, row.app_id, row.version);
      if (revoked && row.state !== "revoked") {
        this.#db.run(
          "UPDATE desktop_app_installations SET state = 'revoked', state_reason = ?, updated_at = ? WHERE app_id = ?",
          revoked.reason,
          this.#now(),
          row.app_id,
        );
        changed.push(row.app_id);
      } else if (!revoked && row.state === "revoked") {
        this.#db.run(
          "UPDATE desktop_app_installations SET state = 'active', state_reason = NULL, updated_at = ? WHERE app_id = ?",
          this.#now(),
          row.app_id,
        );
        changed.push(row.app_id);
      }
    }
    return changed;
  }
}

export type { DesktopAppRegistryKind };
