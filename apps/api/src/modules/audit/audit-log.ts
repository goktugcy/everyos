import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { AuditEvent, AuditOutcome, AuditPage } from "@everyos/shared";

export interface AuditEntry {
  action: string;
  outcome: AuditOutcome;
  actor?: { userId: string; username: string } | null;
  ip?: string | null;
  target?: string | null;
  details?: Record<string, unknown> | null;
}

interface AuditRow {
  id: number;
  ts: number;
  actor_user_id: string | null;
  actor_username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  details: string | null;
}

export interface AuditRetention {
  maxAgeMs: number;
  maxRows: number;
}

export const DEFAULT_AUDIT_RETENTION: AuditRetention = {
  maxAgeMs: 180 * 24 * 3_600_000,
  maxRows: 100_000,
};

/**
 * Structured audit trail for security-relevant actions. Recording never
 * throws: a failing audit write is logged but does not break the request.
 * Every entry is also mirrored to the structured log (journald).
 */
export class AuditLog {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(db: Database, logger: Logger, now: () => number = Date.now) {
    this.#db = db;
    this.#logger = logger.child({ component: "audit" });
    this.#now = now;
  }

  record(entry: AuditEntry): void {
    const ts = this.#now();
    this.#logger.info("audit", {
      action: entry.action,
      outcome: entry.outcome,
      actor: entry.actor?.username ?? null,
      ip: entry.ip ?? null,
      target: entry.target ?? null,
    });
    try {
      this.#db.run(
        `INSERT INTO audit_events (ts, actor_user_id, actor_username, ip, action, target, outcome, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ts,
        entry.actor?.userId ?? null,
        entry.actor?.username ?? null,
        entry.ip ?? null,
        entry.action,
        entry.target ?? null,
        entry.outcome,
        entry.details ? JSON.stringify(entry.details) : null,
      );
    } catch (error) {
      this.#logger.error("Failed to persist audit event", { error, action: entry.action });
    }
  }

  query(options: {
    limit: number;
    before?: number | undefined;
    action?: string | undefined;
  }): AuditPage {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.before !== undefined) {
      conditions.push("id < ?");
      params.push(options.before);
    }
    if (options.action !== undefined) {
      conditions.push("action = ?");
      params.push(options.action);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.#db.all<AuditRow>(
      `SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`,
      ...params,
      options.limit + 1,
    );
    const page = rows.slice(0, options.limit);
    return {
      events: page.map(toAuditEvent),
      nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Deletes entries older than the retention window and caps the row count. */
  prune(retention: AuditRetention = DEFAULT_AUDIT_RETENTION): number {
    const cutoff = this.#now() - retention.maxAgeMs;
    const byAge = this.#db.run("DELETE FROM audit_events WHERE ts < ?", cutoff).changes;
    const byCount = this.#db.run(
      `DELETE FROM audit_events WHERE id <= (
         SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      retention.maxRows,
    ).changes;
    return byAge + byCount;
  }
}

function toAuditEvent(row: AuditRow): AuditEvent {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details) as Record<string, unknown>;
    } catch {
      details = null;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    ip: row.ip,
    action: row.action,
    target: row.target,
    outcome: row.outcome,
    details,
  };
}
