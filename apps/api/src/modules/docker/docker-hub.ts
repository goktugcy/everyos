import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import type {
  ContainerStatsHistory,
  ContainerStatsPoint,
  ContainerStatsSample,
  DockerChangeEvent,
  DockerStatsSnapshot,
} from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";

const SYSTEM_ACTOR: Actor = { kind: "system", component: "docker" };
const HISTORY_WINDOW_MS = 15 * 60_000;
/** Bounds memory on hosts with many containers. */
const MAX_TRACKED_CONTAINERS = 300;

export type DockerHubMessage =
  { kind: "stats"; snapshot: DockerStatsSnapshot } | { kind: "change"; event: DockerChangeEvent };

function rate(previous: number | null, current: number | null, seconds: number): number | null {
  if (previous === null || current === null || seconds <= 0) return null;
  const delta = current - previous;
  return delta < 0 ? null : Math.round(delta / seconds);
}

/** Same CPU formula as `docker stats`, applied between two one-shot samples. */
export function computeContainerPoint(
  previous: ContainerStatsSample | undefined,
  current: ContainerStatsSample,
): ContainerStatsPoint {
  const seconds = previous ? (current.at - previous.at) / 1000 : 0;
  let cpuPercent: number | null = null;
  if (previous && seconds > 0) {
    const cpuDelta = current.cpuTotalNs - previous.cpuTotalNs;
    const systemDelta =
      current.systemCpuNs !== null && previous.systemCpuNs !== null
        ? current.systemCpuNs - previous.systemCpuNs
        : null;
    if (cpuDelta >= 0 && systemDelta !== null && systemDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * (current.onlineCpus ?? 1) * 100;
    } else if (cpuDelta >= 0) {
      cpuPercent = (cpuDelta / (seconds * 1e9)) * 100;
    }
    if (cpuPercent !== null) cpuPercent = Math.round(cpuPercent * 10) / 10;
  }
  return {
    at: current.at,
    cpuPercent,
    memoryBytes: current.memoryBytes,
    memoryLimitBytes: current.memoryLimitBytes,
    netRxBytesPerSec: previous ? rate(previous.netRxBytes, current.netRxBytes, seconds) : null,
    netTxBytesPerSec: previous ? rate(previous.netTxBytes, current.netTxBytes, seconds) : null,
    blockReadBytesPerSec: previous
      ? rate(previous.blockReadBytes, current.blockReadBytes, seconds)
      : null,
    blockWriteBytesPerSec: previous
      ? rate(previous.blockWriteBytes, current.blockWriteBytes, seconds)
      : null,
    pids: current.pids,
  };
}

export interface DockerHubOptions {
  agent: AgentGateway;
  logger: Logger;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Container stats and Docker change events for live views. Sampling (one
 * `stats?one-shot=true` call per running container) and the Docker event
 * stream run only while at least one client subscribes. Each container keeps
 * 15 minutes of points in memory, for at most 300 containers.
 */
export class DockerHub {
  readonly #agent: AgentGateway;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #listeners = new Set<(message: DockerHubMessage) => void>();
  readonly #observers = new Set<(event: DockerChangeEvent) => void>();
  readonly #previous = new Map<string, ContainerStatsSample>();
  readonly #history = new Map<string, ContainerStatsPoint[]>();
  #latest: DockerStatsSnapshot | null = null;
  #timer: NodeJS.Timeout | null = null;
  #events: AbortController | null = null;
  #sampling: Promise<void> | null = null;
  #failures = 0;

  constructor(options: DockerHubOptions) {
    this.#agent = options.agent;
    this.#logger = options.logger.child({ component: "docker-hub" });
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? 5_000;
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  get latest(): DockerStatsSnapshot | null {
    return this.#latest;
  }

  subscribe(listener: (message: DockerHubMessage) => void): () => void {
    this.#listeners.add(listener);
    if (this.#latest) listener({ kind: "stats", snapshot: this.#latest });
    if (!this.#timer) {
      void this.sample();
      this.#timer = setInterval(() => void this.sample(), this.#intervalMs);
      this.#timer.unref();
      this.#followEvents();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#events?.abort();
    this.#events = null;
  }

  /**
   * Observes change events without starting collection (e.g. to refresh the
   * shared `data.docker` widget topic while live views are open).
   */
  onChange(observer: (event: DockerChangeEvent) => void): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  history(id: string): ContainerStatsHistory {
    return { id, resolutionMs: this.#intervalMs, points: this.#history.get(id) ?? [] };
  }

  /** Samples now (concurrent calls share one run). Never throws. */
  sample(): Promise<void> {
    this.#sampling ??= this.#takeSample().finally(() => {
      this.#sampling = null;
    });
    return this.#sampling;
  }

  async #takeSample(): Promise<void> {
    if (this.#agent.state !== "connected") return;
    let result;
    try {
      result = await this.#agent.call("docker.containers.stats", {}, SYSTEM_ACTOR);
    } catch (error) {
      if (this.#failures++ === 0) this.#logger.warn("Container stats sampling failed", { error });
      return;
    }
    this.#failures = 0;
    const at = this.#now();
    const containers: Record<string, ContainerStatsPoint> = {};
    for (const sample of result.samples) {
      const point = computeContainerPoint(this.#previous.get(sample.id), sample);
      this.#previous.set(sample.id, sample);
      containers[sample.id] = point;
      const buffer = this.#history.get(sample.id) ?? [];
      buffer.push(point);
      while (buffer.length > 0 && buffer[0]!.at < at - HISTORY_WINDOW_MS) buffer.shift();
      this.#history.set(sample.id, buffer);
    }
    this.#prune(at);
    this.#latest = { source: result.source, at, containers };
    this.#emit({ kind: "stats", snapshot: this.#latest });
  }

  /** Forgets containers that stopped reporting, oldest first, within the size bound. */
  #prune(at: number): void {
    for (const [id, points] of this.#history) {
      if ((points.at(-1)?.at ?? 0) < at - HISTORY_WINDOW_MS) {
        this.#history.delete(id);
        this.#previous.delete(id);
      }
    }
    while (this.#history.size > MAX_TRACKED_CONTAINERS) {
      const oldest = [...this.#history].sort(
        (a, b) => (a[1].at(-1)?.at ?? 0) - (b[1].at(-1)?.at ?? 0),
      )[0];
      if (!oldest) break;
      this.#history.delete(oldest[0]);
      this.#previous.delete(oldest[0]);
    }
  }

  /** Relays Docker events while subscribed, reconnecting with backoff when the stream ends. */
  #followEvents(): void {
    const controller = new AbortController();
    this.#events = controller;
    void (async () => {
      let delay = 1_000;
      while (!controller.signal.aborted) {
        if (this.#agent.state === "connected") {
          try {
            for await (const event of this.#agent.stream("docker.events", {}, SYSTEM_ACTOR, {
              signal: controller.signal,
            })) {
              delay = 1_000;
              this.#emit({ kind: "change", event });
            }
          } catch (error) {
            if (!controller.signal.aborted)
              this.#logger.debug("Docker event stream ended", { error });
          }
        }
        if (controller.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
        delay = Math.min(delay * 2, 30_000);
      }
    })();
  }

  #emit(message: DockerHubMessage): void {
    if (message.kind === "change")
      for (const observer of this.#observers) {
        try {
          observer(message.event);
        } catch (error) {
          this.#logger.error("Docker change observer failed", { error });
        }
      }
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch (error) {
        this.#logger.error("Docker listener failed", { error });
      }
    }
  }
}
