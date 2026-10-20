import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import type { RegistryAnchor } from "./anchors.ts";
import { RegistryAssets } from "./assets.ts";
import { DesktopAppInstaller } from "./installer.ts";
import { DesktopAppRegistries, type FetcherFactory } from "./registries.ts";

const REFRESH_INTERVAL_MS = 6 * 3_600_000;
const FIRST_REFRESH_MS = 30_000;

/** Desktop apps: registries, the installer and store assets, refreshed in the background. */
export class DesktopAppsService {
  readonly registries: DesktopAppRegistries;
  readonly installer: DesktopAppInstaller;
  readonly assets: RegistryAssets;
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
  }

  /** Syncs every enabled registry and applies their revocations to installed apps. */
  async refresh(): Promise<void> {
    await this.registries.syncAll(this.#controller.signal);
    const changed = this.installer.applyRevocations();
    if (changed.length)
      this.#logger.warn("Registries changed installed apps' state", { apps: changed });
  }

  start(): void {
    const run = () => void this.refresh().catch(() => undefined);
    this.#timers = [setTimeout(run, FIRST_REFRESH_MS), setInterval(run, REFRESH_INTERVAL_MS)];
    for (const timer of this.#timers) timer.unref();
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#controller.abort();
  }
}
