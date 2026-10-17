import type { Permission } from "./permissions.ts";

/*
 * Zod-free notification contracts (docs/notifications.md). Texts are rendered
 * by the client from `kind` + `params`, so notifications stay localizable and
 * never carry preformatted messages.
 */

export const NOTIFICATION_SEVERITIES = ["info", "success", "warning", "critical"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_CATEGORIES = [
  "system",
  "services",
  "storage",
  "docker",
  "network",
  "apps",
  "updates",
  "backups",
  "tasks",
  "security",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Every notification kind with its category and the permission a user needs
 * to see it. Conditions (`condition: true`) are raised while a problem lasts
 * and resolved automatically; the others are one-off events.
 */
export const NOTIFICATION_KINDS = {
  "service-failed": { category: "services", permission: "services:read", condition: true },
  "storage-low": { category: "storage", permission: "system:read", condition: true },
  "container-unhealthy": { category: "docker", permission: "docker:read", condition: true },
  "under-voltage": { category: "system", permission: "system:read", condition: true },
  throttling: { category: "system", permission: "system:read", condition: true },
  "nvme-unhealthy": { category: "storage", permission: "system:read", condition: true },
  "security-updates": { category: "updates", permission: "system:read", condition: true },
  "everyos-update-available": { category: "updates", permission: "system:read", condition: true },
  /** Installed updates wait for the host to restart. */
  "reboot-required": { category: "updates", permission: "system:read", condition: true },
  "internet-offline": { category: "network", permission: "system:read", condition: true },
  "tailscale-offline": { category: "network", permission: "system:read", condition: true },
  "tailscale-key-expiry": { category: "network", permission: "system:read", condition: true },
  /** EveryOS is reachable from the public internet through Tailscale Funnel. */
  "tailscale-funnel": { category: "security", permission: "system:manage", condition: true },
  "agent-unavailable": { category: "system", permission: "system:read", condition: true },
  "app-succeeded": { category: "apps", permission: "apps:read", condition: false },
  "app-failed": { category: "apps", permission: "apps:read", condition: false },
  /** The catalog has a newer definition of an installed app. */
  "app-update-available": { category: "apps", permission: "apps:read", condition: true },
  "updates-installed": { category: "updates", permission: "system:read", condition: false },
  "updates-failed": { category: "updates", permission: "system:read", condition: false },
  "backup-succeeded": { category: "backups", permission: "backups:manage", condition: false },
  "backup-failed": { category: "backups", permission: "backups:manage", condition: false },
  "task-succeeded": { category: "tasks", permission: "tasks:manage", condition: false },
  "task-failed": { category: "tasks", permission: "tasks:manage", condition: false },
  "login-locked": { category: "security", permission: "audit:read", condition: false },
  /** An administrator restarts or powers off the host. */
  "power-scheduled": { category: "system", permission: "system:read", condition: false },
  /** A disk was plugged in (and mounted when EveryOS remembers it). */
  "disk-attached": { category: "storage", permission: "system:manage", condition: false },
  /** A disk was unplugged (a warning when it was still mounted). */
  "disk-detached": { category: "storage", permission: "system:read", condition: false },
  /** A long transfer of the person's own files finished (personal notification). */
  "transfer-succeeded": { category: "storage", permission: "files:read", condition: false },
  "transfer-failed": { category: "storage", permission: "files:read", condition: false },
} as const satisfies Record<
  string,
  { category: NotificationCategory; permission: Permission; condition: boolean }
>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/**
 * Kinds that pop up whatever the minimum pop-up severity: they answer something the person just
 * did (plugging in or pulling out a disk). Muted categories and turned-off pop-ups still apply.
 */
export const ANNOUNCED_KINDS: ReadonlySet<NotificationKind> = new Set([
  "disk-attached",
  "disk-detached",
]);

export const NOTIFICATION_KIND_IDS = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

export type NotificationParams = Record<string, string | number>;

/** One notification as seen by the signed-in user. */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  category: NotificationCategory;
  severity: NotificationSeverity;
  params: NotificationParams;
  /** How often the event happened (deduplicated into this notification). */
  count: number;
  createdAt: number;
  updatedAt: number;
  /** Conditions: when the problem cleared. */
  resolvedAt: number | null;
  read: boolean;
}

export interface NotificationList {
  notifications: NotificationView[];
  nextCursor: string | null;
}

/** Unread, not dismissed notifications per category (the client hides muted ones). */
export type NotificationCounts = Partial<Record<NotificationCategory, number>>;

/** `event: notifications` on the event stream. */
export interface NotificationEvent {
  unread: NotificationCounts;
  /** New or raised-again notification worth a toast; null for read/dismiss changes. */
  latest: NotificationView | null;
}
