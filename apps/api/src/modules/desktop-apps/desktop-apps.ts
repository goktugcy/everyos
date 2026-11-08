import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import type { NotificationService } from "../notifications/notification-service.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { AutomaticAppUpdates } from "./automatic-updates.ts";
import type { RegistryAnchor } from "./anchors.ts";
import { AppDatabases } from "./app-databases.ts";
import { AppFiles } from "./app-files.ts";
import { AppMonitors } from "./app-monitors.ts";
import { AppNetwork } from "./app-network.ts";
import { AppSshKeys } from "./app-ssh-keys.ts";
import { AppUserSettings } from "./app-settings.ts";
import { AppStorage } from "./app-storage.ts";
import { RegistryAssets } from "./assets.ts";
import { DesktopAppInstaller } from "./installer.ts";
import { AppInstances } from "./instances.ts";
import { DesktopAppRegistries, type FetcherFactory } from "./registries.ts";

const REFRESH_INTERVAL_MS = 15 * 60_000;
const STARTUP_RETRY_MS = 30_000;

/** Desktop apps: registries, the installer and store assets, refreshed in the background. */
export class DesktopAppsService {
  readonly registries: DesktopAppRegistries;
  readonly installer: DesktopAppInstaller;
  readonly assets: RegistryAssets;
  /** Running app windows and widgets (their tokens). */
  readonly instances: AppInstances;
  readonly storage: AppStorage;
  /** Files people picked for their apps. */
  readonly files: AppFiles;
  readonly settings: AppUserSettings;
  /** The network policy and the network operations behind network:outbound. */
  readonly network: AppNetwork;
  readonly monitors: AppMonitors;
  /** Databases administrators connected for apps holding database:connect. */
  readonly databases: AppDatabases;
  /** Each person's SSH keys, for apps holding secrets:ssh. */
  readonly sshKeys: AppSshKeys;
  readonly updates: AutomaticAppUpdates;
  readonly #logger: Logger;
  #timers: NodeJS.Timeout[] = [];
  readonly #controller = new AbortController();
  #refreshing: Promise<void> | null = null;

  constructor(options: {
    db: Database;
    secrets: SecretBox;
    logger: Logger;
    now: () => number;
    dir: string;
    anchors: { official: RegistryAnchor | null; community: RegistryAnchor | null };
    fetcher?: FetcherFactory;
    notifications: NotificationService;
    audit: AuditLog;
    /** DNS for the network policy (tests). */
    resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  }) {
    this.#logger = options.logger;
    this.registries = new DesktopAppRegistries({
      db: options.db,
      secrets: options.secrets,
      logger: options.logger,
      now: options.now,
      anchors: options.anchors,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    this.registries.ensureBuiltIns();
    this.installer = new DesktopAppInstaller({
      db: options.db,
      registries: this.registries,
      dir: options.dir,
      now: options.now,
      logger: options.logger,
    });
    this.assets = new RegistryAssets(this.registries);
    this.files = new AppFiles({ db: options.db, now: options.now, dir: options.dir });
    this.instances = new AppInstances(options.now, (instance) => {
      this.files.endInstance(instance.id);
      queueMicrotask(() => {
        void this.updates.check().catch(() => undefined);
      });
    });
    this.updates = new AutomaticAppUpdates({
      installer: this.installer,
      instances: this.instances,
      notifications: options.notifications,
      audit: options.audit,
      now: options.now,
    });
    this.storage = new AppStorage(options.db, options.now);
    this.settings = new AppUserSettings(options.db, options.now);
    this.network = new AppNetwork({
      db: options.db,
      now: options.now,
      ...(options.resolve ? { resolve: options.resolve } : {}),
    });
    this.databases = new AppDatabases({
      db: options.db,
      secrets: options.secrets,
      now: options.now,
    });
    this.sshKeys = new AppSshKeys({
      db: options.db,
      secrets: options.secrets,
      now: options.now,
      dir: options.dir,
    });
    this.monitors = new AppMonitors({
      db: options.db,
      now: options.now,
      network: this.network,
      installer: this.installer,
      settings: this.settings,
      notifications: options.notifications,
      logger: options.logger,
    });
  }

  /** Syncs every enabled registry and applies their revocations to installed apps. */
  refresh(): Promise<void> {
    return (this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null;
    }));
  }

  async #refresh(): Promise<void> {
    await this.registries.syncAll(this.#controller.signal);
    const changed = this.installer.applyRevocations();
    for (const appId of changed) this.instances.closeApp(appId);
    if (changed.length)
      this.#logger.warn("Registries changed installed apps' state", { apps: changed });
    if (!this.#controller.signal.aborted) await this.updates.check();
  }

  /** Unpacks verified packages of installations that lost their files (a restore). */
  async reconcile(): Promise<void> {
    const { restored, disabled } = await this.installer.reconcile();
    if (restored.length) this.#logger.info("Desktop apps restored", { apps: restored });
    if (disabled.length)
      this.#logger.warn("Desktop apps turned off: not verified after a restore", {
        apps: disabled,
      });
  }

  start(): void {
    const run = () => void this.refresh().catch(() => undefined);
    // Updates restart the API: refresh the catalog immediately without delaying startup.
    run();
    this.#timers = [
      setTimeout(run, STARTUP_RETRY_MS),
      setInterval(run, REFRESH_INTERVAL_MS),
      setInterval(() => {
        void this.updates.check().catch(() => undefined);
      }, 60_000),
    ];
    for (const timer of this.#timers) timer.unref();
    this.monitors.start();
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.monitors.stop();
    this.updates.stop();
    this.#controller.abort();
  }
}
