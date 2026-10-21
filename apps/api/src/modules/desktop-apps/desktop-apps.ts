import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import type { NotificationService } from "../notifications/notification-service.ts";
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

const REFRESH_INTERVAL_MS = 6 * 3_600_000;
const FIRST_REFRESH_MS = 30_000;

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
  readonly #logger: Logger;
  #timers: NodeJS.Timeout[] = [];
  readonly #controller = new AbortController();

  constructor(options: {
    db: Database;
    secrets: SecretBox;
    logger: Logger;
    now: () => number;
    dir: string;
    anchors: { official: RegistryAnchor | null; community: RegistryAnchor | null };
    fetcher?: FetcherFactory;
    notifications: NotificationService;
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
    this.instances = new AppInstances(options.now, (instance) =>
      this.files.endInstance(instance.id),
    );
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
  async refresh(): Promise<void> {
    await this.registries.syncAll(this.#controller.signal);
    const changed = this.installer.applyRevocations();
    for (const appId of changed) this.instances.closeApp(appId);
    if (changed.length)
      this.#logger.warn("Registries changed installed apps' state", { apps: changed });
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
    this.#timers = [setTimeout(run, FIRST_REFRESH_MS), setInterval(run, REFRESH_INTERVAL_MS)];
    for (const timer of this.#timers) timer.unref();
    this.monitors.start();
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.monitors.stop();
    this.#controller.abort();
  }
}
