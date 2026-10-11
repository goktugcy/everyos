import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import type {
  MetricRange,
  MetricsHistory,
  MetricsPoint,
  MetricsSample,
  MetricsSnapshot,
} from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";
import { computePoint, computeSnapshot, downsample } from "./rates.ts";

const SYSTEM_ACTOR: Actor = { kind: "system", component: "metrics" };

export interface MetricsHubOptions {
  agent: AgentGateway;
  logger: Logger;
  now?: () => number;
  /** Sampling interval while at least one client watches live metrics. */
  liveIntervalMs?: number;
  /** Background sampling interval that feeds the history, always on. */
  historyIntervalMs?: number;
}

const RECENT_WINDOW_MS = 15 * 60_000;
const HISTORY_WINDOW_MS = 24 * 3_600_000;

const RANGE_MS: Record<MetricRange, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
};

/**
 * Samples host metrics through the agent and fans them out to live
 * subscribers. Fast sampling only runs while someone is watching; a slow
 * background sampler keeps 24 hours of minute-averaged history in memory
 * (bounded: at most 1440 history points and 15 minutes of live points).
 */
export class MetricsHub {
  readonly #agent: AgentGateway;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #liveIntervalMs: number;
  readonly #historyIntervalMs: number;
  readonly #listeners = new Set<(snapshot: MetricsSnapshot) => void>();
  readonly #recent: MetricsPoint[] = [];
  readonly #history: MetricsPoint[] = [];
  #previous: MetricsSample | null = null;
  #historyBase: MetricsSample | null = null;
  #latest: MetricsSnapshot | null = null;
  #liveTimer: NodeJS.Timeout | null = null;
  #historyTimer: NodeJS.Timeout | null = null;
  #sampling: Promise<void> | null = null;
  #failures = 0;

  constructor(options: MetricsHubOptions) {
    this.#agent = options.agent;
    this.#logger = options.logger.child({ component: "metrics" });
    this.#now = options.now ?? Date.now;
    this.#liveIntervalMs = options.liveIntervalMs ?? 2_000;
    this.#historyIntervalMs = options.historyIntervalMs ?? 60_000;
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  get latest(): MetricsSnapshot | null {
    return this.#latest;
  }

  start(): void {
    if (this.#historyTimer) return;
    void this.sample();
    this.#historyTimer = setInterval(() => void this.sample(), this.#historyIntervalMs);
    this.#historyTimer.unref();
  }

  stop(): void {
    if (this.#historyTimer) clearInterval(this.#historyTimer);
    if (this.#liveTimer) clearInterval(this.#liveTimer);
    this.#historyTimer = null;
    this.#liveTimer = null;
  }

  /** Registers a live listener; the latest snapshot (if any) is delivered immediately. */
  subscribe(listener: (snapshot: MetricsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    if (this.#latest) listener(this.#latest);
    if (!this.#liveTimer) {
      void this.sample();
      this.#liveTimer = setInterval(() => void this.sample(), this.#liveIntervalMs);
      this.#liveTimer.unref();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#liveTimer) {
        clearInterval(this.#liveTimer);
        this.#liveTimer = null;
      }
    };
  }

  history(range: MetricRange): MetricsHistory {
    const since = this.#now() - RANGE_MS[range];
    if (range === "15m") {
      return {
        range,
        resolutionMs: this.#liveIntervalMs,
        points: this.#recent.filter((p) => p.at >= since),
      };
    }
    const points = this.#history.filter((p) => p.at >= since);
    if (range === "24h")
      return { range, resolutionMs: 5 * 60_000, points: downsample(points, 5 * 60_000) };
    return { range, resolutionMs: this.#historyIntervalMs, points };
  }

  /** Takes one sample now (concurrent calls share it). Never throws. */
  sample(): Promise<void> {
    this.#sampling ??= this.#takeSample().finally(() => {
      this.#sampling = null;
    });
    return this.#sampling;
  }

  async #takeSample(): Promise<void> {
    if (this.#agent.state !== "connected") return;
    let sample: MetricsSample;
    try {
      sample = await this.#agent.call("metrics.sample", {}, SYSTEM_ACTOR);
    } catch (error) {
      // Log the first failure of a streak only; the agent may simply be restarting.
      if (this.#failures++ === 0) this.#logger.warn("Metrics sampling failed", { error });
      return;
    }
    this.#failures = 0;
    const snapshot = computeSnapshot(this.#previous, sample);
    this.#previous = sample;
    this.#latest = snapshot;
    this.#push(this.#recent, snapshot.point, RECENT_WINDOW_MS);

    // History points average over the whole interval instead of the last 2 seconds.
    const base = this.#historyBase;
    if (!base || sample.at - base.at >= this.#historyIntervalMs * 0.9) {
      if (base) this.#push(this.#history, computePoint(base, sample), HISTORY_WINDOW_MS);
      this.#historyBase = sample;
    }

    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#logger.error("Metrics listener failed", { error });
      }
    }
  }

  #push(buffer: MetricsPoint[], point: MetricsPoint, windowMs: number): void {
    buffer.push(point);
    const cutoff = point.at - windowMs;
    let drop = 0;
    while (drop < buffer.length && buffer[drop]!.at < cutoff) drop++;
    if (drop > 0) buffer.splice(0, drop);
  }
}
