import type { Database } from "@otuken/database";
import { hmacSha256, randomToken, safeEqual, sha256Hex } from "@otuken/security";
import type { SessionSummary } from "@otuken/shared";

export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  /** Set while the session is locked; protected host/account operations are denied. */
  lockedAt: number | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  locked_at: number | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
    lockedAt: row.locked_at,
  };
}

export interface SessionPolicy {
  idleMs: number;
  maxAgeMs: number;
}

/** Writes to last_seen_at are throttled to keep SQLite writes low. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Server-side sessions. The browser holds a random 256-bit token; the
 * database stores only its SHA-256 hash, so a leaked database cannot be used
 * to hijack sessions. CSRF tokens are derived from the session id with a
 * server-side key and never stored.
 */
export class SessionService {
  readonly #db: Database;
  readonly #policy: SessionPolicy;
  readonly #csrfKey: Buffer;
  readonly #now: () => number;

  constructor(db: Database, policy: SessionPolicy, csrfKey: Buffer, now: () => number = Date.now) {
    this.#db = db;
    this.#policy = policy;
    this.#csrfKey = csrfKey;
    this.#now = now;
  }

  create(
    userId: string,
    client: { ip: string | null; userAgent: string | null },
  ): { session: Session; token: string } {
    const now = this.#now();
    const id = randomToken(16);
    const token = randomToken(32);
    const userAgent = client.userAgent ? client.userAgent.slice(0, 256) : null;
    this.#db.run(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      sha256Hex(token),
      now,
      now,
      now + this.#policy.maxAgeMs,
      client.ip,
      userAgent,
    );
    return {
      session: {
        id,
        userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + this.#policy.maxAgeMs,
        ip: client.ip,
        userAgent,
        lockedAt: null,
      },
      token,
    };
  }

  /** Returns the live session for a token, deleting it if it has expired. */
  validate(token: string): Session | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.#db.get<SessionRow>(
      "SELECT * FROM sessions WHERE token_hash = ?",
      sha256Hex(token),
    );
    if (!row) return null;
    const now = this.#now();
    if (row.expires_at <= now || row.last_seen_at + this.#policy.idleMs <= now) {
      this.#db.run("DELETE FROM sessions WHERE id = ?", row.id);
      return null;
    }
    const session = toSession(row);
    if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      this.#db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", now, row.id);
      session.lastSeenAt = now;
    }
    return session;
  }

  /**
   * Current state of a session without extending it. Long-lived streams use
   * this so an open browser tab cannot keep an idle session alive forever.
   */
  peek(sessionId: string): Session | null {
    const row = this.#db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", sessionId);
    if (!row) return null;
    const now = this.#now();
    if (row.expires_at <= now || row.last_seen_at + this.#policy.idleMs <= now) return null;
    return toSession(row);
  }

  /** Effective expiry: whichever of the idle and absolute limits comes first. */
  effectiveExpiry(session: Session): number {
    return Math.min(session.expiresAt, session.lastSeenAt + this.#policy.idleMs);
  }

  listForUser(userId: string, currentSessionId: string | null): SessionSummary[] {
    const now = this.#now();
    return this.#db
      .all<SessionRow>(
        "SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC",
        userId,
        now,
        now - this.#policy.idleMs,
      )
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: Math.min(row.expires_at, row.last_seen_at + this.#policy.idleMs),
        ip: row.ip,
        userAgent: row.user_agent,
        current: row.id === currentSessionId,
      }));
  }

  lock(sessionId: string): void {
    this.#db.run(
      "UPDATE sessions SET locked_at = COALESCE(locked_at, ?) WHERE id = ?",
      this.#now(),
      sessionId,
    );
  }

  unlock(sessionId: string): void {
    this.#db.run("UPDATE sessions SET locked_at = NULL WHERE id = ?", sessionId);
  }

  revoke(sessionId: string): boolean {
    return this.#db.run("DELETE FROM sessions WHERE id = ?", sessionId).changes > 0;
  }

  revokeForUser(userId: string, sessionId: string): boolean {
    return (
      this.#db.run("DELETE FROM sessions WHERE id = ? AND user_id = ?", sessionId, userId).changes >
      0
    );
  }

  /** Signs out every session of a user, optionally keeping one. */
  revokeAllForUser(userId: string, exceptSessionId: string | null = null): number {
    return exceptSessionId
      ? this.#db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", userId, exceptSessionId)
          .changes
      : this.#db.run("DELETE FROM sessions WHERE user_id = ?", userId).changes;
  }

  purgeExpired(): number {
    const now = this.#now();
    return this.#db.run(
      "DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?",
      now,
      now - this.#policy.idleMs,
    ).changes;
  }

  csrfToken(sessionId: string): string {
    return hmacSha256(this.#csrfKey, `otuken-csrf-v1|${sessionId}`).toString("base64url");
  }

  verifyCsrfToken(sessionId: string, candidate: string | undefined): boolean {
    return (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      safeEqual(this.csrfToken(sessionId), candidate)
    );
  }
}
