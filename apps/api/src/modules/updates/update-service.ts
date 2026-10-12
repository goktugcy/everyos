import { randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { UpdateJobAction, UpdateJobView } from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import type { AgentGateway } from "../../services.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { NotificationService } from "../notifications/notification-service.ts";
import { toApiError } from "../../http/agent.ts";

interface Row {
  id: string;
  action: UpdateJobAction;
  packages: string | null;
  status: UpdateJobView["status"];
  username: string | null;
  started_at: number;
  finished_at: number | null;
  upgraded: number | null;
  error: string | null;
  output: string;
}

/** Output kept per job (the end of apt's output). */
const OUTPUT_BYTES = 64 * 1024;
const HISTORY = 50;

function toView(row: Row): UpdateJobView {
  return {
    id: row.id,
    action: row.action,
    packages: row.packages ? (JSON.parse(row.packages) as string[]) : null,
    status: row.status,
    username: row.username,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    upgraded: row.upgraded,
    error: row.error,
    output: row.output,
  };
}

export type UpdateJobEvent = { type: "line"; text: string } | { type: "done"; job: UpdateJobView };

/**
 * Update manager jobs (docs/updates.md). Refreshes and upgrades run one at a
 * time in the background, independent of the HTTP request that started them;
 * progress is streamed, the outcome is stored, audited and announced in the
 * notification center. Nothing here ever starts on its own.
 */
export class UpdateService {
  readonly #db: Database;
  readonly #agent: AgentGateway;
  readonly #audit: AuditLog;
  readonly #notifications: NotificationService;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #onChanged: () => void;
  readonly #listeners = new Map<string, Set<(event: UpdateJobEvent) => void>>();
  #running: { id: string; controller: AbortController } | null = null;

  constructor(deps: {
    db: Database;
    agent: AgentGateway;
    audit: AuditLog;
    notifications: NotificationService;
    logger: Logger;
    now: () => number;
    /** Package lists changed (e.g. refresh the widget topic). */
    onChanged?: () => void;
  }) {
    this.#db = deps.db;
    this.#agent = deps.agent;
    this.#audit = deps.audit;
    this.#notifications = deps.notifications;
    this.#logger = deps.logger.child({ component: "updates" });
    this.#now = deps.now;
    this.#onChanged = deps.onChanged ?? (() => undefined);
    // A restart cannot know how an interrupted apt run ended.
    this.#db.run(
      "UPDATE update_jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
      this.#now(),
    );
  }

  jobs(): UpdateJobView[] {
    return this.#db
      .all<Row>("SELECT * FROM update_jobs ORDER BY started_at DESC, rowid DESC LIMIT ?", HISTORY)
      .map(toView);
  }

  job(id: string): UpdateJobView | null {
    const row = this.#db.get<Row>("SELECT * FROM update_jobs WHERE id = ?", id);
    return row ? toView(row) : null;
  }

  /** Live output of a running job; finished jobs end immediately with `done`. */
  subscribe(id: string, listener: (event: UpdateJobEvent) => void): () => void {
    const set = this.#listeners.get(id) ?? new Set();
    set.add(listener);
    this.#listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(id);
    };
  }

  start(
    action: UpdateJobAction,
    packages: string[] | null,
    actor: Actor & { kind: "user" },
  ): UpdateJobView {
    if (this.#running) throw new ApiError(409, "CONFLICT", "Another update job is running");
    const id = randomUUID();
    this.#db.run(
      `INSERT INTO update_jobs(id, action, packages, status, user_id, username, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      id,
      action,
      packages ? JSON.stringify(packages) : null,
      actor.userId,
      actor.username,
      this.#now(),
    );
    const controller = new AbortController();
    this.#running = { id, controller };
    void this.#run(id, action, packages, actor, controller.signal).finally(() => {
      if (this.#running?.id === id) this.#running = null;
    });
    return this.job(id)!;
  }

  /** Resolves when the job has finished (scheduled tasks wait for their job). */
  wait(id: string, signal?: AbortSignal): Promise<UpdateJobView> {
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(id, (event) => {
        if (event.type !== "done") return;
        unsubscribe();
        resolve(event.job);
      });
      signal?.addEventListener(
        "abort",
        () => {
          if (this.#running?.id === id) this.#running.controller.abort();
        },
        { once: true },
      );
      // It may already have finished before we subscribed.
      const current = this.job(id);
      if (current && current.status !== "running") {
        unsubscribe();
        resolve(current);
      }
    });
  }

  stop(): void {
    this.#running?.controller.abort();
  }

  async #run(
    id: string,
    action: UpdateJobAction,
    packages: string[] | null,
    actor: Actor & { kind: "user" },
    signal: AbortSignal,
  ): Promise<void> {
    let output = "";
    const append = (text: string) => {
      output += `${text}\n`;
      if (output.length > OUTPUT_BYTES * 2) output = output.slice(-OUTPUT_BYTES);
      this.#emit(id, { type: "line", text });
    };
    let ok = false;
    let upgraded: number | null = null;
    let error: string | null = null;
    try {
      if (action === "refresh") {
        const result = await this.#agent.call("apt.refresh", {}, actor, { signal });
        for (const line of result.output.split("\n").filter(Boolean)) append(line);
        ok = result.ok;
        if (!ok) error = result.busy ? "busy" : "apt-failed";
      } else {
        for await (const event of this.#agent.stream("apt.upgrade", { packages }, actor, {
          signal,
        })) {
          if (event.type === "line") append(event.text);
          else {
            ok = event.ok;
            upgraded = event.upgraded;
            if (!ok) error = event.busy ? "busy" : "apt-failed";
          }
        }
      }
    } catch (caught) {
      const failure = toApiError(caught);
      const reason = (failure.details as { reason?: string } | undefined)?.reason?.split(":")[0];
      error = reason && /^[A-Z_]{1,128}$/.test(reason) ? reason : failure.code;
      append(`Error: ${error}. ${failure.message}`);
      this.#logger.warn("Update job failed", { id, action, code: failure.code, reason: error });
    }
    if (!ok && !error) {
      error = signal.aborted ? "interrupted" : "AGENT_INVALID_RESPONSE";
      append(`Error: ${error}`);
    }
    if (!ok && !output.trim()) append(`Error: ${error}`);
    this.#db.run(
      "UPDATE update_jobs SET status = ?, finished_at = ?, upgraded = ?, error = ?, output = ? WHERE id = ?",
      ok ? "succeeded" : signal.aborted ? "interrupted" : "failed",
      this.#now(),
      upgraded,
      error,
      output.slice(-OUTPUT_BYTES),
      id,
    );
    this.#audit.record({
      action: `updates.${action}`,
      outcome: ok ? "success" : "failure",
      actor: { userId: actor.userId, username: actor.username },
      ip: actor.ip ?? null,
      target: packages ? packages.join(" ").slice(0, 512) : action === "upgrade" ? "all" : "lists",
      details: {
        jobId: id,
        ...(upgraded !== null ? { upgraded } : {}),
        ...(error ? { reason: error } : {}),
      },
    });
    if (action === "upgrade")
      this.#notifications.publish(
        ok
          ? {
              kind: "updates-installed",
              severity: "success",
              key: id,
              params: { count: upgraded ?? 0 },
            }
          : {
              kind: "updates-failed",
              severity: "critical",
              key: id,
              params: { reason: error ?? "failed" },
            },
      );
    this.#onChanged();
    if (this.#running?.id === id) this.#running = null;
    this.#emit(id, { type: "done", job: this.job(id)! });
  }

  #emit(id: string, event: UpdateJobEvent): void {
    for (const listener of this.#listeners.get(id) ?? []) {
      try {
        listener(event);
      } catch (error) {
        this.#logger.error("Update listener failed", { error });
      }
    }
  }
}
