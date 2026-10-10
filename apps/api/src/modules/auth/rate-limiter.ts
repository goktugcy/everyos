export interface FailureLimiterOptions {
  /** Failures tolerated within the window before locking. */
  maxFailures: number;
  windowMs: number;
  /** First lock duration; doubles for every further failure while locked out. */
  baseLockMs: number;
  maxLockMs: number;
  /** Upper bound on tracked keys so an attacker cannot exhaust memory. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  lockCount: number;
}

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * In-memory brute-force protection keyed by IP address or username.
 * Successful authentication resets a key. State is intentionally not
 * persisted: a restart clears temporary lockouts but never locks a user out
 * permanently.
 */
export class FailureLimiter {
  readonly #options: Required<FailureLimiterOptions>;
  readonly #entries = new Map<string, Entry>();

  constructor(options: FailureLimiterOptions) {
    this.#options = { maxEntries: 10_000, now: Date.now, ...options };
  }

  check(key: string): LimitDecision {
    const entry = this.#entries.get(key);
    if (!entry) return { allowed: true };
    const now = this.#options.now();
    if (entry.lockedUntil > now) return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    return { allowed: true };
  }

  recordFailure(key: string): void {
    const now = this.#options.now();
    let entry = this.#entries.get(key);
    if (!entry || (now - entry.windowStart > this.#options.windowMs && entry.lockedUntil <= now)) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0, lockCount: entry?.lockCount ?? 0 };
    }
    entry.failures++;
    if (entry.failures >= this.#options.maxFailures) {
      const duration = Math.min(
        this.#options.baseLockMs * 2 ** entry.lockCount,
        this.#options.maxLockMs,
      );
      entry.lockedUntil = now + duration;
      entry.lockCount++;
      entry.failures = 0;
      entry.windowStart = now;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#evict(now);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  #evict(now: number): void {
    if (this.#entries.size <= this.#options.maxEntries) return;
    // Drop expired entries first, then the oldest (Map preserves insertion order).
    for (const [key, entry] of this.#entries) {
      if (entry.lockedUntil <= now && now - entry.windowStart > this.#options.windowMs)
        this.#entries.delete(key);
    }
    while (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
