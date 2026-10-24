import { randomUUID } from "node:crypto";
import type { NetMonitor, NetMonitorCheck, NetMonitorState } from "@everyos/app-sdk/protocol";
import { NET_LIMITS } from "@everyos/app-sdk/protocol";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { AppMonitorSaveSchema } from "@everyos/shared/schemas";
import type { z } from "zod";
import { ApiError, notFound, rateLimited } from "../../http/errors.ts";
import type { NotificationService } from "../notifications/notification-service.ts";
import type { AppNetwork } from "./app-network.ts";
import type { AppUserSettings } from "./app-settings.ts";
import type { DesktopAppInstaller } from "./installer.ts";

const TICK_MS = 10_000;
/** Checks running at once, across all monitors. */
const AT_ONCE = 4;
const MAX_TOTAL = 500;
/** History kept per monitor: the newest checks, none older than 30 days. */
const KEEP_CHECKS = 5000;
const KEEP_MS = 30 * 86_400_000;
const MANUAL_GAP_MS = 10_000;

type SaveInput = z.output<typeof AppMonitorSaveSchema>;

interface Row {
  id: string;
  app_id: string;
  user_id: string;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  interval_seconds: number;
  timeout_ms: number;
  expect_min: number;
  expect_max: number;
  keyword: string | null;
  down_after: number;
  verify_tls: number;
  notify: number;
  enabled: number;
  state: NetMonitorState;
  state_since: number | null;
  failures: number;
  checked_at: number | null;
  last_status: number | null;
  last_ms: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * HTTP monitors desktop apps keep for their people (HTTP Monitor, Uptime): EveryOS checks them on
 * its own schedule, also while the app is closed, through the network policy of the app, and
 * notifies the person when one goes down or comes back.
 */
export class AppMonitors {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #network: AppNetwork;
  readonly #installer: DesktopAppInstaller;
  readonly #settings: AppUserSettings;
  readonly #notifications: NotificationService;
  readonly #logger: Logger;
  readonly #running = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: {
    db: Database;
    now: () => number;
    network: AppNetwork;
    installer: DesktopAppInstaller;
    settings: AppUserSettings;
    notifications: NotificationService;
    logger: Logger;
  }) {
    this.#db = options.db;
    this.#now = options.now;
    this.#network = options.network;
    this.#installer = options.installer;
    this.#settings = options.settings;
    this.#notifications = options.notifications;
    this.#logger = options.logger;
  }

  #view(row: Row): NetMonitor {
    const now = this.#now();
    const stats = (since: number) =>
      this.#db.get<{ uptime: number | null; avg: number | null }>(
        `SELECT AVG(ok) AS uptime, AVG(CASE WHEN ok = 1 THEN ms END) AS avg
         FROM desktop_app_monitor_checks WHERE monitor_id = ? AND at >= ?`,
        row.id,
        since,
      );
    const day = stats(now - 86_400_000);
    const week = stats(now - 7 * 86_400_000);
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      method: row.method,
      intervalSeconds: row.interval_seconds,
      timeoutMs: row.timeout_ms,
      expectStatus: { min: row.expect_min, max: row.expect_max },
      keyword: row.keyword,
      downAfter: row.down_after,
      verifyTls: row.verify_tls === 1,
      notify: row.notify === 1,
      enabled: row.enabled === 1,
      state: row.state,
      stateSince: row.state_since,
      checkedAt: row.checked_at,
      lastStatus: row.last_status,
      lastMs: row.last_ms,
      lastError: row.last_error,
      uptime24h: day?.uptime ?? null,
      uptime7d: week?.uptime ?? null,
      avgMs24h: day?.avg === null || day?.avg === undefined ? null : Math.round(day.avg),
      createdAt: row.created_at,
    };
  }

  #owned(appId: string, userId: string, id: string): Row {
    const row = this.#db.get<Row>(
      "SELECT * FROM desktop_app_monitors WHERE id = ? AND app_id = ? AND user_id = ?",
      id,
      appId,
      userId,
    );
    if (!row) throw notFound("Monitor");
    return row;
  }

  list(appId: string, userId: string): NetMonitor[] {
    return this.#db
      .all<Row>(
        "SELECT * FROM desktop_app_monitors WHERE app_id = ? AND user_id = ? ORDER BY created_at, rowid",
        appId,
        userId,
      )
      .map((row) => this.#view(row));
  }

  /** The newest `limit` checks since `since`, oldest first. */
  history(
    appId: string,
    userId: string,
    id: string,
    since: number | undefined,
    limit: number,
  ): NetMonitorCheck[] {
    this.#owned(appId, userId, id);
    return this.#db
      .all<{
        at: number;
        ok: number;
        status: number | null;
        ms: number | null;
        error: string | null;
      }>(
        `SELECT at, ok, status, ms, error FROM desktop_app_monitor_checks
         WHERE monitor_id = ? AND at >= ? ORDER BY at DESC LIMIT ?`,
        id,
        since ?? 0,
        limit,
      )
      .reverse()
      .map((check) => ({ ...check, ok: check.ok === 1 }));
  }

  /** Creates or changes a monitor; its target must be allowed by the app's network policy now. */
  async save(appId: string, userId: string, input: SaveInput): Promise<NetMonitor> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new ApiError(400, "VALIDATION_FAILED", "Not a URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new ApiError(400, "VALIDATION_FAILED", "Only http and https URLs without credentials");
    url.hash = "";
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    try {
      await this.#network.target(appId, url.hostname, port);
    } catch (error) {
      // A name that does not resolve right now may still be a valid target later.
      if (!(error instanceof ApiError) || error.code === "DESKTOP_APP_NETWORK_BLOCKED") throw error;
    }
    const now = this.#now();
    const previous = input.id ? this.#owned(appId, userId, input.id) : null;
    if (!previous) {
      const counts = this.#db.get<{ mine: number; total: number }>(
        `SELECT COUNT(*) FILTER (WHERE app_id = ? AND user_id = ?) AS mine, COUNT(*) AS total
         FROM desktop_app_monitors`,
        appId,
        userId,
      );
      if ((counts?.mine ?? 0) >= NET_LIMITS.monitors || (counts?.total ?? 0) >= MAX_TOTAL)
        throw new ApiError(409, "CONFLICT", "Too many monitors");
    }
    const targetChanged =
      !previous ||
      previous.url !== url.href ||
      previous.method !== input.method ||
      previous.expect_min !== input.expectStatus.min ||
      previous.expect_max !== input.expectStatus.max ||
      previous.keyword !== input.keyword;
    const state: NetMonitorState = !input.enabled
      ? "paused"
      : targetChanged || previous?.state === "paused"
        ? "pending"
        : previous.state;
    const id = previous?.id ?? randomUUID();
    const values = [
      input.name,
      url.href,
      input.method,
      input.intervalSeconds,
      input.timeoutMs,
      input.expectStatus.min,
      input.expectStatus.max,
      input.method === "GET" ? input.keyword : null,
      input.downAfter,
      input.verifyTls ? 1 : 0,
      input.notify ? 1 : 0,
      input.enabled ? 1 : 0,
      state,
    ];
    if (previous)
      this.#db.run(
        `UPDATE desktop_app_monitors SET name = ?, url = ?, method = ?, interval_seconds = ?,
           timeout_ms = ?, expect_min = ?, expect_max = ?, keyword = ?, down_after = ?, verify_tls = ?,
           notify = ?, enabled = ?, state = ?, state_since = ?, failures = ?, checked_at = ?,
           updated_at = ?
         WHERE id = ?`,
        ...values,
        state === previous.state ? previous.state_since : now,
        state === previous.state ? previous.failures : 0,
        // A changed target is checked on the next round.
        targetChanged ? null : previous.checked_at,
        now,
        id,
      );
    else
      this.#db.run(
        `INSERT INTO desktop_app_monitors(name, url, method, interval_seconds, timeout_ms,
           expect_min, expect_max, keyword, down_after, verify_tls, notify, enabled, state,
           state_since, failures, id, app_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        ...values,
        now,
        id,
        appId,
        userId,
        now,
        now,
      );
    return this.#view(this.#owned(appId, userId, id));
  }

  delete(appId: string, userId: string, id: string): void {
    this.#owned(appId, userId, id);
    this.#db.run("DELETE FROM desktop_app_monitors WHERE id = ?", id);
  }

  /** Checks one monitor now (at most once every ten seconds). */
  async checkNow(appId: string, userId: string, id: string): Promise<NetMonitor> {
    const row = this.#owned(appId, userId, id);
    const now = this.#now();
    if (row.checked_at !== null && now - row.checked_at < MANUAL_GAP_MS)
      throw rateLimited(MANUAL_GAP_MS - (now - row.checked_at));
    if (this.#running.has(id)) throw rateLimited(MANUAL_GAP_MS);
    await this.#check(row);
    return this.#view(this.#owned(appId, userId, id));
  }

  start(): void {
    this.#timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Runs the monitors that are due (a few at a time). */
  async tick(): Promise<void> {
    const room = AT_ONCE - this.#running.size;
    if (room <= 0) return;
    const due = this.#db
      .all<Row>(
        `SELECT * FROM desktop_app_monitors
         WHERE enabled = 1 AND (checked_at IS NULL OR checked_at + interval_seconds * 1000 <= ?)
         ORDER BY COALESCE(checked_at, 0) LIMIT ?`,
        this.#now(),
        room + this.#running.size,
      )
      .filter((row) => !this.#running.has(row.id))
      .slice(0, room);
    await Promise.all(due.map((row) => this.#check(row)));
  }

  async #check(row: Row): Promise<void> {
    this.#running.add(row.id);
    try {
      const active = this.#installer.active(row.app_id);
      const now = this.#now();
      if (!active || !active.granted.has("network:outbound")) {
        this.#db.run(
          `UPDATE desktop_app_monitors SET state = 'paused', state_since = CASE WHEN state = 'paused'
             THEN state_since ELSE ? END, checked_at = ? WHERE id = ?`,
          now,
          now,
          row.id,
        );
        return;
      }
      let ok = false;
      let blocked = false;
      let status: number | null = null;
      let ms: number | null = null;
      let error: string | null = null;
      try {
        const response = await this.#network.http(row.app_id, null, {
          method: row.method,
          url: row.url,
          headers: [],
          body: null,
          followRedirects: true,
          verifyTls: row.verify_tls === 1,
          timeoutMs: row.timeout_ms,
        });
        status = response.status;
        ms = response.timing.total;
        ok = status >= row.expect_min && status <= row.expect_max;
        if (!ok) error = "status";
        else if (
          row.keyword &&
          !(response.body.encoding === "text" && response.body.data.includes(row.keyword))
        ) {
          ok = false;
          error = "keyword";
        }
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === "DESKTOP_APP_NETWORK_BLOCKED") {
          blocked = true;
          error = "blocked";
        } else
          error =
            caught instanceof ApiError
              ? ((caught.details as { reason?: string } | null)?.reason ?? "error")
              : "error";
      }
      const at = this.#now();
      let state = row.state;
      let failures = row.failures;
      let event: "app-monitor-down" | "app-monitor-recovered" | null = null;
      if (blocked) {
        state = "blocked";
        failures = 0;
      } else if (ok) {
        failures = 0;
        if (row.state === "down") event = "app-monitor-recovered";
        state = "up";
      } else {
        failures += 1;
        if (failures >= row.down_after) {
          if (row.state !== "down") event = "app-monitor-down";
          state = "down";
        } else if (state === "blocked" || state === "paused") state = "pending";
      }
      this.#db.transaction(() => {
        this.#db.run(
          `INSERT OR REPLACE INTO desktop_app_monitor_checks(monitor_id, at, ok, status, ms, error)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.id,
          at,
          ok ? 1 : 0,
          status,
          ms,
          error,
        );
        this.#db.run(
          `UPDATE desktop_app_monitors SET state = ?, state_since = ?, failures = ?, checked_at = ?,
             last_status = ?, last_ms = ?, last_error = ? WHERE id = ?`,
          state,
          state === row.state ? row.state_since : at,
          failures,
          at,
          status,
          ms,
          error,
          row.id,
        );
        this.#db.run(
          `DELETE FROM desktop_app_monitor_checks WHERE monitor_id = ? AND (at < ? OR at <= (
             SELECT at FROM desktop_app_monitor_checks WHERE monitor_id = ?
             ORDER BY at DESC LIMIT 1 OFFSET ?))`,
          row.id,
          at - KEEP_MS,
          row.id,
          KEEP_CHECKS,
        );
      });
      if (
        event &&
        row.notify === 1 &&
        active.granted.has("notifications:send") &&
        this.#settings.notificationsEnabled(row.app_id, row.user_id)
      )
        this.#notifications.publish({
          kind: event,
          severity: event === "app-monitor-down" ? "warning" : "success",
          key: row.id,
          params: {
            app: active.manifest.name,
            appId: row.app_id,
            name: row.name,
            target: new URL(row.url).host,
            reason: error ?? "",
          },
          userId: row.user_id,
        });
    } catch (error) {
      this.#logger.warn("An app monitor check failed", {
        monitor: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running.delete(row.id);
    }
  }
}
