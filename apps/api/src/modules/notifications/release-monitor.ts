import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import { compareVersions } from "@everyos/release";
import type { SelfUpdateStatus } from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";
import type { NotificationService } from "./notification-service.ts";

const ACTOR: Actor = { kind: "system", component: "release-monitor" };
const CHECK_INTERVAL_MS = 60 * 60_000;
const RETRY_INTERVAL_MS = 15 * 60_000;

/** Reads the agent's verified release status. It never queues or installs an update. */
export class ReleaseMonitor {
  readonly #agent: AgentGateway;
  readonly #notifications: NotificationService;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #nextRemoteAt = 0;

  constructor(deps: {
    agent: AgentGateway;
    notifications: NotificationService;
    logger: Logger;
    now: () => number;
  }) {
    this.#agent = deps.agent;
    this.#notifications = deps.notifications;
    this.#logger = deps.logger.child({ component: "release-monitor" });
    this.#now = deps.now;
  }

  start(firstDelayMs = 20_000): void {
    if (this.#timer || this.#controller.signal.aborted) return;
    const loop = (delay: number) => {
      this.#timer = setTimeout(() => {
        void this.check().finally(() => {
          if (!this.#controller.signal.aborted) loop(60_000);
        });
      }, delay);
      this.#timer.unref();
    };
    loop(firstDelayMs);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#controller.abort();
  }

  /** Manual About checks and background checks share the same durable notification condition. */
  observe(status: SelfUpdateStatus): void {
    if (this.#controller.signal.aborted) return;
    const available =
      status.configured &&
      status.reason === null &&
      status.architecture !== null &&
      status.available &&
      compareVersions(status.available.version, status.installedVersion) > 0
        ? status.available
        : null;
    const active = new Set<string>();
    if (available) {
      this.#notifications.raise({
        kind: "everyos-update-available",
        severity: "warning",
        key: available.version,
        params: { version: available.version, installedVersion: status.installedVersion },
      });
      active.add(`everyos-update-available:${available.version}`);
    }
    this.#notifications.resolveMissing(["everyos-update-available"], active);
  }

  check(): Promise<void> {
    if (this.#controller.signal.aborted) return Promise.resolve();
    this.#running ??= this.#check()
      .catch((error: unknown) => {
        this.#logger.warn("Release notification check failed", { error });
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  async #check(): Promise<void> {
    if (this.#agent.state !== "connected") return;
    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(120_000)]);
    let status = await this.#agent.call("release.status", {}, ACTOR, { signal });
    if (
      status.configured &&
      status.reason === null &&
      status.architecture !== null &&
      this.#now() >= this.#nextRemoteAt &&
      (status.checkedAt === null || this.#now() - status.checkedAt >= CHECK_INTERVAL_MS)
    ) {
      this.#nextRemoteAt = this.#now() + RETRY_INTERVAL_MS;
      try {
        status = await this.#agent.call("release.check", {}, ACTOR, { signal });
        this.#nextRemoteAt = this.#now() + CHECK_INTERVAL_MS;
      } catch (error) {
        this.#logger.warn("Remote release check failed; retaining verified cached status", {
          error,
        });
      }
    }
    this.observe(status);
  }
}
