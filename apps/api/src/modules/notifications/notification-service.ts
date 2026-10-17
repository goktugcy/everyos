import { randomUUID } from "node:crypto";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import {
  ANNOUNCED_KINDS,
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationCounts,
  type NotificationKind,
  type NotificationList,
  type NotificationParams,
  type NotificationSeverity,
  type NotificationView,
  type Permission,
} from "@everyos/shared";

/** A stored notification, independent of any viewer. */
export interface StoredNotification {
  id: string;
  kind: NotificationKind;
  category: NotificationCategory;
  severity: NotificationSeverity;
  permission: Permission;
  /** Only this user sees it (null: everyone with `permission`). */
  userId: string | null;
  params: NotificationParams;
  count: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/**
 * External delivery channel (Telegram, e-mail, web push, …). Providers get new
 * and re-raised notifications only, never read/dismiss changes; failures are
 * logged and never affect the in-app notification.
 */
export interface NotificationProvider {
  readonly id: string;
  deliver(notification: StoredNotification): Promise<void>;
}

export type NotificationChange =
  /** Created, raised again or updated; `toast` when users should be told now. */
  | { type: "changed"; notification: StoredNotification; toast: boolean }
  /** A user's read/dismissed state changed (sync their other tabs). */
  | { type: "state"; userId: string };

export interface NotificationViewer {
  id: string;
  permissions: ReadonlySet<Permission>;
}

interface Row {
  id: string;
  kind: string;
  category: string;
  severity: string;
  permission: string;
  user_id: string | null;
  dedupe_key: string;
  params: string;
  count: number;
  created_at: number;
  updated_at: number;
  notified_at: number;
  resolved_at: number | null;
}

/** Repeated events within this window merge into one notification. */
const EVENT_DEDUPE_MS = 60 * 60_000;
/** A merged event alerts users again (pop-up, unread) at most this often. */
const RENOTIFY_MS = 15 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_ROWS = 2_000;

const rank = (severity: string) =>
  NOTIFICATION_SEVERITIES.indexOf(severity as NotificationSeverity);

function toStored(row: Row): StoredNotification {
  let params: NotificationParams = {};
  try {
    params = JSON.parse(row.params) as NotificationParams;
  } catch {
    // Keep an empty parameter set rather than failing the list.
  }
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    category: row.category as NotificationCategory,
    severity: row.severity as NotificationSeverity,
    permission: row.permission as Permission,
    userId: row.user_id,
    params,
    count: row.count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

/** Bounded parameters: short strings and finite numbers only. */
function sanitize(params: NotificationParams = {}): NotificationParams {
  const out: NotificationParams = {};
  for (const [key, value] of Object.entries(params).slice(0, 12)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key.slice(0, 32)] = value;
    else if (typeof value === "string") out[key.slice(0, 32)] = value.slice(0, 200);
  }
  return out;
}

/**
 * The notification center (docs/notifications.md). Conditions (a failed
 * service, a full disk) are raised once and resolved when they clear; events
 * (an app installed, a backup failed) are merged within an hour so repeated
 * identical alerts never flood users.
 */
export class NotificationService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #providers: NotificationProvider[];
  readonly #listeners = new Set<(change: NotificationChange) => void>();

  constructor(deps: {
    db: Database;
    logger: Logger;
    now: () => number;
    providers?: NotificationProvider[];
  }) {
    this.#db = deps.db;
    this.#logger = deps.logger.child({ component: "notifications" });
    this.#now = deps.now;
    this.#providers = deps.providers ?? [];
  }

  addProvider(provider: NotificationProvider): void {
    this.#providers.push(provider);
  }

  subscribe(listener: (change: NotificationChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Raises a condition; a no-op while the same condition is already open (unless it got worse). */
  raise(input: {
    kind: NotificationKind;
    severity: NotificationSeverity;
    key?: string;
    params?: NotificationParams;
  }): void {
    const key = `${input.kind}:${input.key ?? ""}`;
    const params = sanitize(input.params);
    const now = this.#now();
    const open = this.#db.get<Row>(
      "SELECT * FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL",
      key,
    );
    if (open) {
      if (rank(input.severity) > rank(open.severity)) {
        this.#db.transaction(() => {
          this.#db.run(
            "UPDATE notifications SET severity = ?, params = ?, updated_at = ?, notified_at = ? WHERE id = ?",
            input.severity,
            JSON.stringify(params),
            now,
            now,
            open.id,
          );
          this.#resetStates(open.id);
        });
        this.#changed(open.id, true);
      } else if (open.params !== JSON.stringify(params)) {
        // Fresh details (e.g. the disk filled further) without alerting again.
        this.#db.run(
          "UPDATE notifications SET params = ? WHERE id = ?",
          JSON.stringify(params),
          open.id,
        );
        this.#changed(open.id, false);
      }
      return;
    }
    this.#changed(this.#insert(input.kind, input.severity, key, params, null, now), true);
  }

  /** Clears an open condition. */
  resolve(kind: NotificationKind, key = ""): void {
    const open = this.#db.get<{ id: string }>(
      "SELECT id FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL",
      `${kind}:${key}`,
    );
    if (!open) return;
    this.#db.run("UPDATE notifications SET resolved_at = ? WHERE id = ?", this.#now(), open.id);
    this.#changed(open.id, false);
  }

  /** Resolves open conditions of `kinds` that are not in `active` (keys as given to `raise`). */
  resolveMissing(kinds: readonly NotificationKind[], active: ReadonlySet<string>): void {
    if (kinds.length === 0) return;
    const open = this.#db.all<{ kind: NotificationKind; dedupe_key: string }>(
      "SELECT kind, dedupe_key FROM notifications WHERE resolved_at IS NULL AND kind IN (SELECT value FROM json_each(?))",
      JSON.stringify(kinds),
    );
    for (const { kind, dedupe_key: dedupeKey } of open) {
      const key = dedupeKey.slice(kind.length + 1);
      if (!active.has(`${kind}:${key}`)) this.resolve(kind, key);
    }
  }

  /** Records a one-off event; the same event within an hour is merged (count + 1). */
  publish(input: {
    kind: NotificationKind;
    severity: NotificationSeverity;
    key?: string;
    params?: NotificationParams;
    userId?: string;
  }): void {
    const key = `${input.kind}:${input.key ?? ""}`;
    const params = sanitize(input.params);
    const now = this.#now();
    const recent = this.#db.get<Row>(
      "SELECT * FROM notifications WHERE dedupe_key = ? AND updated_at > ? AND user_id IS ? ORDER BY updated_at DESC LIMIT 1",
      key,
      now - EVENT_DEDUPE_MS,
      input.userId ?? null,
    );
    if (!recent) {
      this.#changed(
        this.#insert(input.kind, input.severity, key, params, input.userId ?? null, now),
        true,
      );
      return;
    }
    // Announced kinds answer what the person just did: each one pops up, as it is now.
    const announced = ANNOUNCED_KINDS.has(input.kind);
    const renotify = announced || now - recent.notified_at >= RENOTIFY_MS;
    this.#db.transaction(() => {
      this.#db.run(
        "UPDATE notifications SET count = count + 1, params = ?, severity = ?, updated_at = ?, notified_at = ? WHERE id = ?",
        JSON.stringify(params),
        announced || rank(input.severity) > rank(recent.severity)
          ? input.severity
          : recent.severity,
        now,
        renotify ? now : recent.notified_at,
        recent.id,
      );
      // It happened again: show it as unread, even if it was read or dismissed.
      this.#resetStates(recent.id);
    });
    this.#changed(recent.id, renotify);
  }

  list(
    viewer: NotificationViewer,
    query: {
      severity?: NotificationSeverity | undefined;
      category?: NotificationCategory | undefined;
      unread?: boolean | undefined;
      limit: number;
      before?: string | undefined;
    },
  ): NotificationList {
    const where = [this.#visible(), "s.dismissed_at IS NULL"];
    const params: Array<string | number> = [viewer.id, ...this.#visibleParams(viewer)];
    if (query.severity) {
      where.push("n.severity = ?");
      params.push(query.severity);
    }
    if (query.category) {
      where.push("n.category = ?");
      params.push(query.category);
    }
    if (query.unread) where.push("s.read_at IS NULL");
    const cursor = query.before ? decodeCursor(query.before) : null;
    if (cursor) {
      where.push("(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))");
      params.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = this.#db.all<Row & { read_at: number | null }>(
      `SELECT n.*, s.read_at FROM notifications n
       LEFT JOIN notification_states s ON s.notification_id = n.id AND s.user_id = ?
       WHERE ${where.join(" AND ")}
       ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`,
      ...params,
      query.limit + 1,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      notifications: page.map((row) => view(toStored(row), row.read_at !== null)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.updated_at, last.id) : null,
    };
  }

  /** Unread, not dismissed notifications per category. */
  counts(viewer: NotificationViewer): NotificationCounts {
    const rows = this.#db.all<{ category: NotificationCategory; unread: number }>(
      `SELECT n.category, COUNT(*) AS unread FROM notifications n
       LEFT JOIN notification_states s ON s.notification_id = n.id AND s.user_id = ?
       WHERE ${this.#visible()} AND s.dismissed_at IS NULL AND s.read_at IS NULL
       GROUP BY n.category`,
      viewer.id,
      ...this.#visibleParams(viewer),
    );
    return Object.fromEntries(rows.map((row) => [row.category, row.unread]));
  }

  /** The viewer's state of one notification, or null when they cannot see it. */
  viewFor(viewer: NotificationViewer, notification: StoredNotification): NotificationView | null {
    if (!viewer.permissions.has(notification.permission)) return null;
    if (notification.userId !== null && notification.userId !== viewer.id) return null;
    const state = this.#db.get<{ read_at: number | null; dismissed_at: number | null }>(
      "SELECT read_at, dismissed_at FROM notification_states WHERE notification_id = ? AND user_id = ?",
      notification.id,
      viewer.id,
    );
    if (state?.dismissed_at) return null;
    return view(notification, Boolean(state?.read_at));
  }

  setRead(
    viewer: NotificationViewer,
    target: { ids: string[] } | { all: true },
    read: boolean,
  ): number {
    const now = this.#now();
    const changed = this.#upsertStates(
      viewer,
      target,
      read ? "read_at = COALESCE(read_at, excluded.read_at)" : "read_at = NULL",
      read ? now : null,
      null,
    );
    if (changed > 0) this.#emit({ type: "state", userId: viewer.id });
    return changed;
  }

  dismiss(viewer: NotificationViewer, target: { ids: string[] } | { all: true }): number {
    const now = this.#now();
    const changed = this.#upsertStates(
      viewer,
      target,
      "dismissed_at = excluded.dismissed_at, read_at = COALESCE(read_at, excluded.read_at)",
      now,
      now,
    );
    if (changed > 0) this.#emit({ type: "state", userId: viewer.id });
    return changed;
  }

  /** Drops old notifications (30 days) and keeps at most 2 000. */
  prune(): number {
    const now = this.#now();
    const old = this.#db.run(
      "DELETE FROM notifications WHERE updated_at < ? AND (resolved_at IS NOT NULL OR kind NOT IN (SELECT value FROM json_each(?)))",
      now - RETENTION_MS,
      JSON.stringify(
        Object.entries(NOTIFICATION_KINDS)
          .filter(([, k]) => k.condition)
          .map(([id]) => id),
      ),
    ).changes;
    const excess = this.#db.run(
      `DELETE FROM notifications WHERE id IN (
         SELECT id FROM notifications ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?)`,
      MAX_ROWS,
    ).changes;
    return Number(old) + Number(excess);
  }

  #visible(): string {
    return "n.permission IN (SELECT value FROM json_each(?)) AND (n.user_id IS NULL OR n.user_id = ?)";
  }

  #visibleParams(viewer: NotificationViewer): string[] {
    return [JSON.stringify([...viewer.permissions]), viewer.id];
  }

  #upsertStates(
    viewer: NotificationViewer,
    target: { ids: string[] } | { all: true },
    update: string,
    readAt: number | null,
    dismissedAt: number | null,
  ): number {
    const scope =
      "ids" in target
        ? "AND n.id IN (SELECT value FROM json_each(?))"
        : "AND NOT EXISTS (SELECT 1 FROM notification_states d WHERE d.notification_id = n.id AND d.user_id = ? AND d.dismissed_at IS NOT NULL)";
    const result = this.#db.run(
      `INSERT INTO notification_states(notification_id, user_id, read_at, dismissed_at)
       SELECT n.id, ?, ?, ? FROM notifications n WHERE ${this.#visible()} ${scope}
       ON CONFLICT(notification_id, user_id) DO UPDATE SET ${update}`,
      viewer.id,
      readAt,
      dismissedAt,
      ...this.#visibleParams(viewer),
      "ids" in target ? JSON.stringify(target.ids) : viewer.id,
    );
    return Number(result.changes);
  }

  #insert(
    kind: NotificationKind,
    severity: NotificationSeverity,
    key: string,
    params: NotificationParams,
    userId: string | null,
    now: number,
  ): string {
    const id = randomUUID();
    const definition = NOTIFICATION_KINDS[kind];
    this.#db.run(
      `INSERT INTO notifications(id, kind, category, severity, permission, user_id, dedupe_key, params, count, created_at, updated_at, notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      kind,
      definition.category,
      severity,
      definition.permission,
      userId,
      key,
      JSON.stringify(params),
      now,
      now,
      now,
    );
    return id;
  }

  #resetStates(id: string): void {
    this.#db.run("DELETE FROM notification_states WHERE notification_id = ?", id);
  }

  #changed(id: string, toast: boolean): void {
    const row = this.#db.get<Row>("SELECT * FROM notifications WHERE id = ?", id);
    if (!row) return;
    const notification = toStored(row);
    this.#emit({ type: "changed", notification, toast });
    if (!toast) return;
    for (const provider of this.#providers) {
      provider.deliver(notification).catch((error: unknown) => {
        this.#logger.warn("Notification provider failed", { provider: provider.id, error });
      });
    }
  }

  #emit(change: NotificationChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#logger.error("Notification listener failed", { error });
      }
    }
  }
}

function view(notification: StoredNotification, read: boolean): NotificationView {
  return {
    id: notification.id,
    kind: notification.kind,
    category: notification.category,
    severity: notification.severity,
    params: notification.params,
    count: notification.count,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    resolvedAt: notification.resolvedAt,
    read,
  };
}

function encodeCursor(at: number, id: string): string {
  return Buffer.from(`${at}:${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: number; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  const time = Number(at);
  return Number.isSafeInteger(time) && id ? { at: time, id } : null;
}

/** Mirrors notifications into the service log (journald), so headless hosts keep a record. */
export function logProvider(logger: Logger): NotificationProvider {
  const log = logger.child({ component: "notifications" });
  return {
    id: "log",
    deliver(notification) {
      const level =
        notification.severity === "critical" || notification.severity === "warning"
          ? "warn"
          : "info";
      log[level]("Notification", {
        kind: notification.kind,
        severity: notification.severity,
        params: notification.params,
        count: notification.count,
      });
      return Promise.resolve();
    },
  };
}
