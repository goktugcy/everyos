import {
  isErrorCode,
  type NotificationKind,
  type NotificationView,
  type Permission,
} from "@everyos/shared";
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
  // Off-site copy reasons such as "s3:AccessDenied" (":" separates i18n namespaces).
  const offsite = t(`backups.secure.reasons.${reason.replace(/:/g, "-") as "network"}`, {
    defaultValue: "",
  });
  if (offsite) return offsite;
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
  if (typeof params.power === "string")
    params.power = t(`hostPower.progress.${params.power as "reboot"}`, {
      defaultValue: params.power,
    });
  if (params.mounted === "yes" || params.mounted === "no")
    params.mounted = t(`disks.attachedState.${params.mounted}`);
  if (params.unsafe === "yes" || params.unsafe === "no")
    params.unsafe = t(`disks.detachedState.${params.unsafe}`);
  return {
    title: t(`notifications.kinds.${notification.kind}.title`, params),
    body: t(`notifications.kinds.${notification.kind}.body`, params),
  };
}

const ACTIONS: Partial<
  Record<NotificationKind, { appId: AppId; appState?: Record<string, string> }>
> = {
  "service-failed": { appId: "everyos.services", appState: { filter: "failed" } },
  "storage-low": { appId: "everyos.system", appState: { tab: "storage" } },
  "nvme-unhealthy": { appId: "everyos.system", appState: { tab: "hardware" } },
  "under-voltage": { appId: "everyos.system", appState: { tab: "hardware" } },
  throttling: { appId: "everyos.system", appState: { tab: "hardware" } },
  "container-unhealthy": { appId: "everyos.docker", appState: { tab: "containers" } },
  "internet-offline": { appId: "everyos.system", appState: { tab: "network" } },
  "tailscale-offline": { appId: "everyos.tailscale" },
  "tailscale-key-expiry": { appId: "everyos.tailscale" },
  "tailscale-funnel": { appId: "everyos.tailscale" },
  "agent-unavailable": { appId: "everyos.system" },
  "app-succeeded": { appId: "everyos.store", appState: { tab: "installed" } },
  "app-failed": { appId: "everyos.store", appState: { tab: "installed" } },
  "app-update-available": { appId: "everyos.store", appState: { tab: "installed" } },
  "login-locked": { appId: "everyos.audit" },
  "security-updates": { appId: "everyos.updates" },
  "reboot-required": { appId: "everyos.updates" },
  "disk-attached": { appId: "everyos.settings", appState: { section: "disks" } },
  "disk-detached": { appId: "everyos.settings", appState: { section: "disks" } },
  "everyos-update-available": { appId: "everyos.settings", appState: { section: "about" } },
  "backup-succeeded": { appId: "everyos.backups" },
  "backup-failed": { appId: "everyos.backups" },
  "backup-offsite-failed": { appId: "everyos.backups" },
  "task-succeeded": { appId: "everyos.tasks" },
  "task-failed": { appId: "everyos.tasks" },
  "updates-installed": { appId: "everyos.updates", appState: { tab: "history" } },
  "updates-failed": { appId: "everyos.updates", appState: { tab: "history" } },
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
