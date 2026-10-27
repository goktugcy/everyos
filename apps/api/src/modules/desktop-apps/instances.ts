import { randomBytes } from "node:crypto";

/** One running app window or widget frame, bound to the session that opened it. */
export interface AppInstance {
  /** Stable id (stored with temporary file grants); the token itself is never stored. */
  id: string;
  token: string;
  appId: string;
  userId: string;
  sessionId: string;
  kind: "window" | "widget";
  widgetId: string | null;
  createdAt: number;
  lastUsedAt: number;
  /** Token bucket for the instance's request rate. */
  tokens: number;
}

const MAX_PER_SESSION = 64;
const IDLE_MS = 12 * 3_600_000;
const RATE_PER_SECOND = 40;
const BURST = 200;

/**
 * Instance tokens live in memory only: a restart ends every instance (the desktop opens new ones).
 * A token is useless without its session, since every call must carry both.
 */
export class AppInstances {
  readonly #byToken = new Map<string, AppInstance>();
  readonly #now: () => number;
  readonly #onClose: (instance: AppInstance) => void;

  constructor(now: () => number, onClose: (instance: AppInstance) => void = () => undefined) {
    this.#now = now;
    this.#onClose = onClose;
  }

  #end(instance: AppInstance): void {
    this.#byToken.delete(instance.token);
    this.#onClose(instance);
  }

  open(
    input: Pick<AppInstance, "appId" | "userId" | "sessionId" | "kind" | "widgetId">,
  ): AppInstance {
    this.#sweep();
    const mine = [...this.#byToken.values()]
      .filter((instance) => instance.sessionId === input.sessionId)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    // A tab that leaks instances (or crashes repeatedly) loses its oldest ones first.
    for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_PER_SESSION + 1)))
      this.#end(stale);
    const now = this.#now();
    const instance: AppInstance = {
      ...input,
      id: randomBytes(12).toString("hex"),
      token: randomBytes(24).toString("base64url"),
      createdAt: now,
      lastUsedAt: now,
      tokens: BURST,
    };
    this.#byToken.set(instance.token, instance);
    return instance;
  }

  /** The instance for a token used in the given session, or null. */
  resolve(token: string | undefined, sessionId: string): AppInstance | null {
    if (!token || token.length > 64) return null;
    const instance = this.#byToken.get(token);
    if (!instance || instance.sessionId !== sessionId) return null;
    if (this.#now() - instance.lastUsedAt > IDLE_MS) {
      this.#end(instance);
      return null;
    }
    return instance;
  }

  /** Spends one request from the instance's budget; false when it is exhausted. */
  take(instance: AppInstance): boolean {
    const now = this.#now();
    instance.tokens = Math.min(
      BURST,
      instance.tokens + ((now - instance.lastUsedAt) / 1000) * RATE_PER_SECOND,
    );
    instance.lastUsedAt = now;
    if (instance.tokens < 1) return false;
    instance.tokens -= 1;
    return true;
  }

  close(token: string): void {
    const instance = this.#byToken.get(token);
    if (instance) this.#end(instance);
  }

  /** Ends every instance of an app (uninstalled, disabled, revoked or updated). */
  closeApp(appId: string): void {
    for (const instance of [...this.#byToken.values()])
      if (instance.appId === appId) this.#end(instance);
  }

  #sweep(): void {
    const now = this.#now();
    for (const instance of [...this.#byToken.values()])
      if (now - instance.lastUsedAt > IDLE_MS) this.#end(instance);
  }
}
