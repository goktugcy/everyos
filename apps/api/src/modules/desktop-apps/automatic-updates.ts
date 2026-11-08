import type { AuditLog } from "../audit/audit-log.ts";
import type { NotificationService } from "../notifications/notification-service.ts";
import { ApiError } from "../../http/errors.ts";
import type { DesktopAppInstaller } from "./installer.ts";
import type { AppInstances } from "./instances.ts";

const RETRY_MS = 15 * 60_000;
interface Dependencies {
  installer: DesktopAppInstaller;
  instances: AppInstances;
  notifications: NotificationService;
  audit: AuditLog;
  now: () => number;
}

/** Only signed official updates, with existing grants, while no window/widget is running. */
export class AutomaticAppUpdates {
  readonly #deps: Dependencies;
  readonly #retryAt = new Map<string, number>();
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  check(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return (this.#running ??= this.#check().finally(() => {
      this.#running = null;
    }));
  }

  stop(): void {
    this.#stopped = true;
  }

  async #check(): Promise<void> {
    const { installer, instances, notifications, audit, now } = this.#deps;
    const candidates = installer
      .listings()
      .filter(
        (app) =>
          app.registry.kind === "official" &&
          app.installed?.state === "active" &&
          app.installed.registryId === app.registry.id &&
          app.updateAvailable &&
          !app.conflict,
      );
    const keys = new Set(candidates.map((app) => `${app.appId}@${app.updateAvailable}`));
    for (const key of this.#retryAt.keys()) if (!keys.has(key)) this.#retryAt.delete(key);
    for (const app of candidates) {
      if (this.#stopped) break;
      const version = app.updateAvailable!;
      const key = `${app.appId}@${version}`;
      if ((this.#retryAt.get(key) ?? 0) > now()) continue;
      const release = instances.reserveIdle(app.appId);
      if (!release) continue;
      try {
        await installer.update(
          app.appId,
          { version, approve: [] },
          { userId: "system", permissions: new Set() },
          true,
        );
        audit.record({
          action: "desktop-apps.auto-update",
          target: app.appId,
          outcome: "success",
          details: { component: "official-app-updater", from: app.installed!.version, to: version },
        });
        notifications.resolve("desktop-app-update-approval", app.appId);
        notifications.resolve("desktop-app-update-failed", app.appId);
        notifications.publish({
          kind: "desktop-app-updated",
          severity: "success",
          key,
          params: { app: app.name, appId: app.appId, version },
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === "DESKTOP_APP_BUSY") continue;
        const approval =
          error instanceof ApiError && error.code === "DESKTOP_APP_APPROVAL_REQUIRED";
        const reason = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
        this.#retryAt.set(key, now() + RETRY_MS);
        audit.record({
          action: "desktop-apps.auto-update",
          target: app.appId,
          outcome: "failure",
          details: { component: "official-app-updater", to: version, reason },
        });
        notifications.raise({
          kind: approval ? "desktop-app-update-approval" : "desktop-app-update-failed",
          severity: "warning",
          key: app.appId,
          params: { app: app.name, appId: app.appId, version, reason },
        });
      } finally {
        release();
      }
    }
    const pending = new Set(
      candidates.flatMap((app) => [
        `desktop-app-update-approval:${app.appId}`,
        `desktop-app-update-failed:${app.appId}`,
      ]),
    );
    notifications.resolveMissing(
      ["desktop-app-update-approval", "desktop-app-update-failed"],
      pending,
    );
  }
}
