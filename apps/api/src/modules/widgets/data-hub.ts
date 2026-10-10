import type { Logger } from "@otuken/logger";
import type { Permission, TopicMessage, TopicUnavailableReason } from "@otuken/shared";

export type ProviderResult =
  | { status: "ok"; data: unknown }
  | { status: "unavailable"; reason: TopicUnavailableReason }
  | { status: "error"; code: string };

/** One shared data source behind a topic (docs/contracts.md §3.2). */
export interface DataProvider {
  topic: string;
  /** All are required of every subscriber (checked per subscriber). */
  permissions: readonly Permission[];
  /** Collection interval; the hub never collects more often. */
  intervalMs: number;
  collect(signal: AbortSignal): Promise<ProviderResult>;
  /** Per-subscriber view of the shared data (e.g. alerts filtered by permission). */
  view?: (data: unknown, permissions: ReadonlySet<Permission>) => unknown;
}

interface Subscriber {
  permissions: ReadonlySet<Permission>;
  listener: (message: TopicMessage) => void;
}

interface TopicState {
  provider: DataProvider;
  subscribers: Set<Subscriber>;
  last: TopicMessage | null;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  failures: number;
  controller: AbortController;
}

/** Bounds memory: at most this many distinct topics are active at once. */
const MAX_ACTIVE_TOPICS = 256;
const COLLECT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface DataHubOptions {
  logger: Logger;
  now?: () => number;
  /** Static providers plus a resolver for dynamic topics (integrations). */
  providers: readonly DataProvider[];
  resolve?: (topic: string) => DataProvider | null;
}

/**
 * Reference-counted, shared topic collection. However many widgets, tabs and
 * users read a topic, the server runs one collector for it, only while
 * someone is subscribed, and caches the last value for new subscribers.
 * Failures back off exponentially (up to five minutes).
 */
export class DataHub {
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #static: Map<string, DataProvider>;
  readonly #resolve: (topic: string) => DataProvider | null;
  readonly #topics = new Map<string, TopicState>();

  constructor(options: DataHubOptions) {
    this.#logger = options.logger.child({ component: "data-hub" });
    this.#now = options.now ?? Date.now;
    this.#static = new Map(options.providers.map((provider) => [provider.topic, provider]));
    this.#resolve = options.resolve ?? (() => null);
  }

  get activeTopics(): number {
    return this.#topics.size;
  }

  /** The provider of a topic, if it exists. */
  provider(topic: string): DataProvider | null {
    return this.#static.get(topic) ?? this.#resolve(topic);
  }

  subscribe(
    topic: string,
    permissions: ReadonlySet<Permission>,
    listener: (message: TopicMessage) => void,
  ): () => void {
    const subscriber: Subscriber = { permissions, listener };
    if (!this.#attach(topic, subscriber)) return () => undefined;
    // Looked up at call time: `invalidate` may have replaced the topic's state.
    return () => {
      const current = this.#topics.get(topic);
      if (current?.subscribers.delete(subscriber) && current.subscribers.size === 0)
        this.#stop(topic, current);
    };
  }

  #attach(topic: string, subscriber: Subscriber): boolean {
    const fail = (code: string) => {
      subscriber.listener({ topic, at: this.#now(), status: "error", code });
      return false;
    };
    let state = this.#topics.get(topic);
    const provider = state?.provider ?? this.provider(topic);
    if (!provider) return fail("NOT_FOUND");
    if (!provider.permissions.every((permission) => subscriber.permissions.has(permission)))
      return fail("FORBIDDEN");
    if (!state) {
      if (this.#topics.size >= MAX_ACTIVE_TOPICS) return fail("RATE_LIMITED");
      state = {
        provider,
        subscribers: new Set(),
        last: null,
        timer: null,
        running: null,
        failures: 0,
        controller: new AbortController(),
      };
      this.#topics.set(topic, state);
    }
    state.subscribers.add(subscriber);
    if (state.last) this.#deliver(state, subscriber, state.last);
    if (state.subscribers.size === 1 && !state.running) void this.#cycle(topic, state);
    return true;
  }

  /** Collects a topic now (e.g. Docker reported a change); no-op without subscribers. */
  refresh(topic: string): void {
    const state = this.#topics.get(topic);
    if (!state || state.running) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    void this.#cycle(topic, state);
  }

  /**
   * Drops cached state of topics matching a prefix (an integration changed or
   * was deleted). Current subscribers get a fresh collection or an error.
   */
  invalidate(prefix: string): void {
    for (const [topic, state] of [...this.#topics]) {
      if (!topic.startsWith(prefix)) continue;
      const provider = this.provider(topic);
      const subscribers = [...state.subscribers];
      this.#stop(topic, state);
      // The same subscriber objects are re-attached, so their unsubscribe functions keep working.
      for (const subscriber of subscribers) {
        if (!provider)
          subscriber.listener({ topic, at: this.#now(), status: "error", code: "NOT_FOUND" });
        else this.#attach(topic, subscriber);
      }
    }
  }

  stop(): void {
    for (const [topic, state] of [...this.#topics]) this.#stop(topic, state);
  }

  #stop(topic: string, state: TopicState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.controller.abort();
    state.subscribers.clear();
    if (this.#topics.get(topic) === state) this.#topics.delete(topic);
  }

  async #cycle(topic: string, state: TopicState): Promise<void> {
    const run = (async () => {
      let result: ProviderResult;
      try {
        const signal = AbortSignal.any([
          state.controller.signal,
          AbortSignal.timeout(COLLECT_TIMEOUT_MS),
        ]);
        result = await state.provider.collect(signal);
      } catch (error) {
        if (state.controller.signal.aborted) return;
        if (state.failures === 0)
          this.#logger.warn("Widget data collection failed", { topic, error });
        result = { status: "error", code: "INTERNAL_ERROR" };
      }
      if (state.controller.signal.aborted) return;
      state.failures = result.status === "ok" ? 0 : state.failures + 1;
      const at = this.#now();
      const message: TopicMessage =
        result.status === "ok"
          ? { topic, at, status: "ok", data: result.data }
          : result.status === "unavailable"
            ? { topic, at, status: "unavailable", reason: result.reason }
            : { topic, at, status: "error", code: result.code };
      state.last = message;
      for (const subscriber of state.subscribers) this.#deliver(state, subscriber, message);
    })();
    state.running = run;
    await run;
    state.running = null;
    if (state.controller.signal.aborted || state.subscribers.size === 0) return;
    const delay =
      state.failures === 0
        ? state.provider.intervalMs
        : Math.min(MAX_BACKOFF_MS, state.provider.intervalMs * 2 ** Math.min(state.failures, 6));
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#cycle(topic, state);
    }, delay);
    state.timer.unref();
  }

  #deliver(state: TopicState, subscriber: Subscriber, message: TopicMessage): void {
    try {
      const view = state.provider.view;
      subscriber.listener(
        message.status === "ok" && view
          ? { ...message, data: view(message.data, subscriber.permissions) }
          : message,
      );
    } catch (error) {
      this.#logger.error("Widget data listener failed", { topic: message.topic, error });
    }
  }
}
