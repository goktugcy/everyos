import { randomToken } from "@otuken/security";

export interface LoginChallenge {
  id: string;
  userId: string;
  ip: string;
  expiresAt: number;
  attempts: number;
}

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * Pending second-factor challenges issued after a correct password. They
 * live only in memory; an API restart simply requires signing in again.
 */
export class LoginChallengeStore {
  readonly #challenges = new Map<string, LoginChallenge>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(now: () => number = Date.now, maxEntries = 1_000) {
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  create(userId: string, ip: string): LoginChallenge {
    this.#sweep();
    const challenge: LoginChallenge = {
      id: randomToken(24),
      userId,
      ip,
      expiresAt: this.#now() + CHALLENGE_TTL_MS,
      attempts: 0,
    };
    this.#challenges.set(challenge.id, challenge);
    return challenge;
  }

  /** Returns a live challenge bound to the same client IP, or null. */
  get(id: string, ip: string): LoginChallenge | null {
    const challenge = this.#challenges.get(id);
    if (!challenge) return null;
    if (challenge.expiresAt <= this.#now() || challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      this.#challenges.delete(id);
      return null;
    }
    return challenge.ip === ip ? challenge : null;
  }

  recordFailure(id: string): void {
    const challenge = this.#challenges.get(id);
    if (!challenge) return;
    challenge.attempts++;
    if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) this.#challenges.delete(id);
  }

  delete(id: string): void {
    this.#challenges.delete(id);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, challenge] of this.#challenges)
      if (challenge.expiresAt <= now) this.#challenges.delete(id);
    while (this.#challenges.size >= this.#maxEntries) {
      const oldest = this.#challenges.keys().next().value;
      if (oldest === undefined) break;
      this.#challenges.delete(oldest);
    }
  }
}
