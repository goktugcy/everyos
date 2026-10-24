import { LIMITS, type MatchRequest, type MatchResult } from "./match-core.ts";

/*
 * Runs matches in a worker with a time limit. A run that takes too long terminates the worker
 * (the only way to stop a regular expression mid-match) and the next run starts a fresh one.
 */

export type Outcome =
  MatchResult | { ok: false; error: "timeout" } | { ok: false; error: "worker"; message: string };

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export function createMatcher(start: () => Promise<WorkerLike>, timeoutMs = LIMITS.timeoutMs) {
  let worker: Promise<WorkerLike> | null = null;
  let next = 1;
  let pending: {
    id: number;
    resolve: (outcome: Outcome) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const stop = () => {
    const current = worker;
    worker = null;
    void current?.then((instance) => instance.terminate()).catch(() => undefined);
  };

  const ready = () => {
    worker ??= start().then((instance) => {
      instance.onmessage = (event: MessageEvent<{ id: number; result: MatchResult }>) => {
        if (!pending || event.data.id !== pending.id) return;
        clearTimeout(pending.timer);
        const { resolve } = pending;
        pending = null;
        resolve(event.data.result);
      };
      instance.onerror = (event) => {
        if (!pending) return;
        clearTimeout(pending.timer);
        const { resolve } = pending;
        pending = null;
        stop();
        resolve({ ok: false, error: "worker", message: event.message });
      };
      return instance;
    });
    return worker;
  };

  return {
    /** Runs `request`; an earlier run still going is abandoned (its worker stopped). */
    async run(request: MatchRequest): Promise<Outcome> {
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: "timeout" });
        pending = null;
        stop();
      }
      let instance: WorkerLike;
      try {
        instance = await ready();
      } catch (error) {
        worker = null;
        return {
          ok: false,
          error: "worker",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const id = next++;
      return new Promise<Outcome>((resolve) => {
        const timer = setTimeout(() => {
          if (pending?.id !== id) return;
          pending = null;
          stop();
          resolve({ ok: false, error: "timeout" });
        }, timeoutMs);
        pending = { id, resolve, timer };
        instance.postMessage({ id, request });
      });
    },
    dispose: stop,
  };
}
