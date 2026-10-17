import { randomUUID } from "node:crypto";
import type { Logger } from "@everyos/logger";
import {
  KEPT_FINISHED_TRANSFERS,
  MAX_RUNNING_TRANSFERS,
  type TransferDirection,
  type TransferView,
} from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import type { NotificationService } from "../notifications/notification-service.ts";

/** What a running transfer reports. */
export interface TransferProgress {
  bytes(count: number): void;
  /** One more file is complete. */
  item(): void;
  /** Totals once they are known (a folder is counted before it is copied). */
  totals(totals: { bytes?: number | null; items?: number | null }): void;
}

export interface TransferTask {
  direction: TransferDirection;
  name: string;
  from: string;
  to: string;
  bytesTotal?: number | null;
  itemsTotal?: number | null;
  run(progress: TransferProgress, signal: AbortSignal): Promise<void>;
}

interface Job {
  userId: string;
  view: TransferView;
  task: TransferTask;
  controller: AbortController;
  sample: { at: number; bytes: number } | null;
}

type Listener = (transfers: TransferView[]) => void;

/** Transfers shorter than this finish quietly; longer ones end with a notification. */
const NOTIFY_AFTER_MS = 20_000;
const SAMPLE_MS = 500;
const EMIT_MS = 250;

/**
 * Server-side transfers per person (docs/transfers.md): a small queue, live progress with a
 * smoothed speed and time left, cancellation, and a notification when a long one ends. Jobs live
 * in memory; an API restart ends them.
 */
export class TransferService {
  readonly #jobs = new Map<string, Job>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #pending = new Map<string, NodeJS.Timeout>();
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #notifications: NotificationService | null;
  #ticker: NodeJS.Timeout | null = null;

  constructor(deps: { now: () => number; logger: Logger; notifications?: NotificationService }) {
    this.#now = deps.now;
    this.#logger = deps.logger.child({ component: "transfers" });
    this.#notifications = deps.notifications ?? null;
  }

  start(userId: string, task: TransferTask): TransferView {
    const view: TransferView = {
      id: randomUUID(),
      direction: task.direction,
      name: task.name,
      from: task.from,
      to: task.to,
      state: "queued",
      bytesDone: 0,
      bytesTotal: task.bytesTotal ?? null,
      itemsDone: 0,
      itemsTotal: task.itemsTotal ?? null,
      speed: 0,
      etaSeconds: null,
      error: null,
      createdAt: this.#now(),
      startedAt: null,
      finishedAt: null,
    };
    this.#jobs.set(view.id, {
      userId,
      view,
      task,
      controller: new AbortController(),
      sample: null,
    });
    this.#prune(userId);
    this.#schedule(userId);
    this.#changed(userId);
    return { ...view };
  }

  list(userId: string): TransferView[] {
    return [...this.#jobs.values()]
      .filter((job) => job.userId === userId)
      .map((job) => ({ ...job.view }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  cancel(userId: string, id: string): TransferView {
    const job = this.#jobs.get(id);
    if (!job || job.userId !== userId) throw new ApiError(404, "NOT_FOUND", "No such transfer");
    if (job.view.state === "queued") this.#finish(job, "cancelled", null);
    else if (job.view.state === "running") job.controller.abort();
    return { ...job.view };
  }

  /** Forgets finished transfers. */
  clear(userId: string): void {
    for (const [id, job] of this.#jobs)
      if (job.userId === userId && job.view.finishedAt !== null) this.#jobs.delete(id);
    this.#changed(userId);
  }

  /** The person's transfers whenever they change; the current list is sent at once. */
  subscribe(userId: string, listener: Listener): () => void {
    let set = this.#listeners.get(userId);
    if (!set) this.#listeners.set(userId, (set = new Set()));
    set.add(listener);
    listener(this.list(userId));
    return () => {
      set.delete(listener);
      if (!set.size) this.#listeners.delete(userId);
    };
  }

  /** Whether any transfer is waiting or running (a restart would interrupt it). */
  active(): number {
    return [...this.#jobs.values()].filter(
      (job) => job.view.state === "queued" || job.view.state === "running",
    ).length;
  }

  stop(): void {
    for (const job of this.#jobs.values()) job.controller.abort();
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }

  #schedule(userId: string): void {
    const mine = [...this.#jobs.values()].filter((job) => job.userId === userId);
    let running = mine.filter((job) => job.view.state === "running").length;
    for (const job of mine.sort((a, b) => a.view.createdAt - b.view.createdAt)) {
      if (running >= MAX_RUNNING_TRANSFERS) break;
      if (job.view.state !== "queued") continue;
      running++;
      void this.#run(job);
    }
  }

  async #run(job: Job): Promise<void> {
    job.view.state = "running";
    job.view.startedAt = this.#now();
    job.sample = { at: this.#now(), bytes: 0 };
    this.#tick();
    this.#changed(job.userId);
    const progress: TransferProgress = {
      bytes: (count) => {
        job.view.bytesDone += count;
        this.#changed(job.userId);
      },
      item: () => {
        job.view.itemsDone++;
        this.#changed(job.userId);
      },
      totals: ({ bytes, items }) => {
        if (bytes !== undefined) job.view.bytesTotal = bytes;
        if (items !== undefined) job.view.itemsTotal = items;
        this.#changed(job.userId);
      },
    };
    try {
      await job.task.run(progress, job.controller.signal);
      if (job.controller.signal.aborted) this.#finish(job, "cancelled", null);
      else this.#finish(job, "done", null);
    } catch (error) {
      if (job.controller.signal.aborted) this.#finish(job, "cancelled", null);
      else {
        const code = error instanceof ApiError ? error.code : "TRANSFER_FAILED";
        if (!(error instanceof ApiError))
          this.#logger.warn("Transfer failed", { id: job.view.id, error });
        this.#finish(job, "failed", code);
      }
    }
  }

  #finish(job: Job, state: "done" | "failed" | "cancelled", error: string | null): void {
    job.view.state = state;
    job.view.error = error;
    job.view.finishedAt = this.#now();
    job.view.speed = 0;
    job.view.etaSeconds = null;
    job.sample = null;
    if (
      this.#notifications &&
      state !== "cancelled" &&
      (state === "failed" ||
        job.view.finishedAt - (job.view.startedAt ?? job.view.createdAt) >= NOTIFY_AFTER_MS)
    )
      this.#notifications.publish({
        kind: state === "done" ? "transfer-succeeded" : "transfer-failed",
        severity: state === "done" ? "info" : "warning",
        key: job.view.id,
        userId: job.userId,
        params: {
          name: job.view.name,
          to: job.view.to,
          direction: job.view.direction,
          ...(error ? { reason: error } : {}),
        },
      });
    this.#prune(job.userId);
    this.#schedule(job.userId);
    this.#changed(job.userId);
  }

  /** Keeps the newest finished transfers. */
  #prune(userId: string): void {
    const finished = [...this.#jobs.values()]
      .filter((job) => job.userId === userId && job.view.finishedAt !== null)
      .sort((a, b) => b.view.finishedAt! - a.view.finishedAt!);
    for (const job of finished.slice(KEPT_FINISHED_TRANSFERS)) this.#jobs.delete(job.view.id);
  }

  /** Speed and time left, from samples every half second while anything runs. */
  #tick(): void {
    if (this.#ticker) return;
    this.#ticker = setInterval(() => {
      const now = this.#now();
      let running = 0;
      for (const job of this.#jobs.values()) {
        if (job.view.state !== "running" || !job.sample) continue;
        running++;
        const elapsed = (now - job.sample.at) / 1000;
        if (elapsed <= 0) continue;
        const instant = (job.view.bytesDone - job.sample.bytes) / elapsed;
        job.view.speed = job.view.speed ? job.view.speed * 0.7 + instant * 0.3 : instant;
        job.sample = { at: now, bytes: job.view.bytesDone };
        const left =
          job.view.bytesTotal !== null
            ? Math.max(0, job.view.bytesTotal - job.view.bytesDone)
            : null;
        job.view.etaSeconds =
          left !== null && job.view.speed > 1 ? Math.ceil(left / job.view.speed) : null;
        this.#changed(job.userId);
      }
      if (!running && this.#ticker) {
        clearInterval(this.#ticker);
        this.#ticker = null;
      }
    }, SAMPLE_MS);
    this.#ticker.unref?.();
  }

  /** Coalesces updates: listeners get at most four lists a second. */
  #changed(userId: string): void {
    if (this.#pending.has(userId) || !this.#listeners.has(userId)) return;
    const timer = setTimeout(() => {
      this.#pending.delete(userId);
      const listeners = this.#listeners.get(userId);
      if (!listeners) return;
      const list = this.list(userId);
      for (const listener of listeners) listener(list);
    }, EMIT_MS);
    timer.unref?.();
    this.#pending.set(userId, timer);
  }
}
