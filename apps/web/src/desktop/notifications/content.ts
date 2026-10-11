import {
  isErrorCode,
  type NotificationKind,
  type NotificationView,
  type Permission,
} from "@otuken/shared";
import type { TFunction } from "i18next";
import { getApp, isAppAllowed } from "../apps/registry.ts";
import type { AppId } from "../apps/types.ts";

/**
 * A failure reason as text: notification reasons first, then backup job
 * reasons, then API error codes (without their final period), else the code.
 */
export function reasonText(t: TFunction, reason: string): string {
  const known = t(`notifications.reasons.${reason as "compose-failed"}`, { defaultValue: "" });
  if (known) return known;
  const code = reason.split(":")[0]!;
  const job = t(`backups.jobErrors.${code as "app-busy"}`, { defaultValue: "" });
  if (job) return job;
  if (isErrorCode(code)) return t(`errors.${code}`).replace(/\.$/, "");
  return reason;
}

/** Localized title and body; parameters that are codes are translated too. */
export function notificationText(
  t: TFunction,
  notification: Pick<NotificationView, "kind" | "params">,
): { title: string; body: string } {
  const params: Record<string, string | number> = { ...notification.params };
  if (typeof params.action === "string")
    params.action = t(`appStore.actions.${params.action as "install"}`, {
      defaultValue: params.action,
    });
  if (typeof params.reason === "string") params.reason = reasonText(t, params.reason);
  return {
    title: t(`notifications.kinds.${notification.kind}.title`, params),
    body: t(`notifications.kinds.${notification.kind}.body`, params),
  };
}

const ACTIONS: Partial<
  Record<NotificationKind, { appId: AppId; appState?: Record<string, string> }>
> = {
  "service-failed": { appId: "otuken.services", appState: { filter: "failed" } },
  "storage-low": { appId: "otuken.system", appState: { tab: "storage" } },
  "nvme-unhealthy": { appId: "otuken.system", appState: { tab: "hardware" } },
  "under-voltage": { appId: "otuken.system", appState: { tab: "hardware" } },
  throttling: { appId: "otuken.system", appState: { tab: "hardware" } },
  "container-unhealthy": { appId: "otuken.docker", appState: { tab: "containers" } },
  "internet-offline": { appId: "otuken.system", appState: { tab: "network" } },
  "tailscale-offline": { appId: "otuken.tailscale" },
  "tailscale-key-expiry": { appId: "otuken.tailscale" },
  "tailscale-funnel": { appId: "otuken.tailscale" },
  "agent-unavailable": { appId: "otuken.system" },
  "app-succeeded": { appId: "otuken.store", appState: { tab: "installed" } },
  "app-failed": { appId: "otuken.store", appState: { tab: "installed" } },
  "login-locked": { appId: "otuken.audit" },
  "security-updates": { appId: "otuken.updates" },
  "backup-succeeded": { appId: "otuken.backups" },
  "backup-failed": { appId: "otuken.backups" },
  "task-succeeded": { appId: "otuken.tasks" },
  "task-failed": { appId: "otuken.tasks" },
  "updates-installed": { appId: "otuken.updates", appState: { tab: "history" } },
  "updates-failed": { appId: "otuken.updates", appState: { tab: "history" } },
};

/** Where a notification leads, if the user may open that app. */
export function notificationAction(
  kind: NotificationKind,
  permissions: readonly Permission[],
): { appId: AppId; appState?: Record<string, string> } | null {
  const action = ACTIONS[kind];
  const manifest = action ? getApp(action.appId) : undefined;
  return action && manifest && isAppAllowed(manifest, permissions) ? action : null;
}
