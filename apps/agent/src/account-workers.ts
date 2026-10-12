import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import {
  AGENT_OPERATIONS,
  OperationError,
  type Actor,
  type OperationContext,
  type OperationHandlers,
} from "@everyos/agent-protocol";
import type { LinuxAccount } from "@everyos/shared";
import type { AgentConfig } from "./config.ts";
import type { LinuxIdentities } from "./linux-identities.ts";
import { spawnAccount } from "./account-process.ts";

interface WorkerFiles {
  roots: Array<{ id: string; name: string; path: string; readOnly: boolean }>;
  maxUploadBytes: number;
  minFreeBytes: number;
}

interface Pending {
  frames: unknown[];
  error?: OperationError;
  done: boolean;
  wake: () => void;
}
interface Worker {
  child: ChildProcessWithoutNullStreams;
  uid: number;
  account: string;
  identityStamp: string;
  pending: Map<number, Pending>;
  at: number;
}

/** File/system work runs with real UID, GID and supplementary groups in bounded account workers. */
export class AccountWorkers {
  readonly #workers = new Map<string, Worker>();
  readonly #config: AgentConfig;
  readonly #identities: LinuxIdentities;
  readonly #files: WorkerFiles;
  readonly #version: string;
  #sequence = 0;

  constructor(options: {
    config: AgentConfig;
    identities: LinuxIdentities;
    files: WorkerFiles;
    version: string;
  }) {
    this.#config = options.config;
    this.#identities = options.identities;
    this.#files = {
      roots: options.files.roots,
      maxUploadBytes: options.files.maxUploadBytes,
      minFreeBytes: options.files.minFreeBytes,
    };
    this.#version = options.version;
    const timer = setInterval(() => {
      for (const [id, worker] of this.#workers)
        if (!worker.pending.size && Date.now() - worker.at > 10 * 60_000) this.closeUser(id);
    }, 60_000);
    timer.unref();
  }

  closeUser(
    userId: string,
    error = new OperationError("policy_denied", "LINUX_ACCOUNT_REQUIRED"),
  ): void {
    const worker = this.#workers.get(userId);
    if (!worker) return;
    this.#workers.delete(userId);
    worker.child.stdin.end();
    worker.child.kill("SIGTERM");
    for (const pending of worker.pending.values()) {
      pending.error = error;
      pending.done = true;
      pending.wake();
    }
  }
  closeAll(): void {
    for (const id of this.#workers.keys()) this.closeUser(id);
  }

  wrap(handlers: OperationHandlers): OperationHandlers {
    const mapped = { ...handlers };
    // These return public host telemetry or EveryOS-owned metadata. No private host reads.
    const publicReads = new Set([
      "agent.ping",
      "system.info",
      "metrics.sample",
      "power.status",
      "hardware.status",
      "network.status",
      "storage.usage",
      "release.status",
      "release.check",
      "apps.inspect",
    ]);
    for (const [op, contract] of Object.entries(AGENT_OPERATIONS)) {
      if (op.startsWith("identity.") || op.startsWith("terminal.") || publicReads.has(op)) continue;
      const original = handlers[op as keyof OperationHandlers] as (
        p: unknown,
        c: OperationContext,
      ) => unknown;
      const execute = async (params: unknown, context: OperationContext) => {
        if (context.actor.kind === "system") return original(params, context);
        this.#identities.resolve(context.actor);
        // Root-owned application/release state and root-only package/service actions need sudo.
        const privileged =
          op.startsWith("backups.") ||
          op.startsWith("apps.") ||
          op === "release.install" ||
          (op.startsWith("apt.") && contract.mutating) ||
          op === "services.control";
        if (
          privileged ||
          (!op.startsWith("files.") &&
            (!contract.mutating || op.startsWith("docker.")) &&
            this.#identities.status(context.actor).privilegedUntil !== null)
        ) {
          await this.#identities.requirePrivilege(context.actor);
          return original(params, context);
        }
        const stream = this.#run(op, params, context);
        if (contract.kind === "stream") return stream;
        let result: unknown;
        for await (const frame of stream) result = frame;
        return result;
      };
      const handler =
        contract.kind === "unary"
          ? execute
          : async function* (params: unknown, context: OperationContext) {
              const stream = (await execute(params, context)) as AsyncIterable<unknown>;
              yield* stream;
            };
      Object.assign(mapped, { [op]: handler });
    }
    return mapped;
  }

  #worker(actor: Extract<Actor, { kind: "user" }>, account: LinuxAccount): Worker {
    const identityStamp = `${account.gid}:${account.home}:${account.shell}:${statSync("/etc/group").mtimeMs}`;
    const current = this.#workers.get(actor.userId);
    if (
      current?.uid === account.uid &&
      current.identityStamp === identityStamp &&
      current.account === account.name &&
      current.child.exitCode === null &&
      !current.child.killed
    )
      return current;
    if (current) this.closeUser(actor.userId);
    if (this.#workers.size >= 16) throw new OperationError("busy", "Too many account workers");
    const child = spawnAccount(account, process.execPath, [
      join(dirname(process.argv[1]!), "account-worker.mjs"),
    ]);
    const worker: Worker = {
      child,
      uid: account.uid,
      account: account.name,
      identityStamp,
      pending: new Map(),
      at: Date.now(),
    };
    this.#workers.set(actor.userId, worker);
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error("Worker frame too large");
        const frame = JSON.parse(line) as {
          id: number;
          result?: unknown;
          event?: unknown;
          error?: { code: OperationError["code"]; message: string };
        };
        const pending = worker.pending.get(frame.id);
        if (!pending) return;
        if (frame.error) {
          pending.error = new OperationError(frame.error.code, frame.error.message);
          pending.done = true;
        } else if ("result" in frame) {
          pending.frames.push(frame.result);
          pending.done = true;
        } else pending.frames.push(frame.event);
        if (pending.frames.length > 128) {
          pending.error = new OperationError("busy", "Consumer too slow");
          pending.done = true;
          child.stdin.write(`${JSON.stringify({ cancel: frame.id })}\n`);
        }
        pending.wake();
      } catch {
        this.closeUser(actor.userId);
      }
    });
    const failed = () => {
      if (this.#workers.get(actor.userId) === worker)
        this.closeUser(
          actor.userId,
          new OperationError("failed", "Linux account worker could not start"),
        );
      lines.close();
    };
    child.once("error", failed);
    child.once("close", failed);
    child.stdin.write(
      `${JSON.stringify({ account, userId: actor.userId, version: this.#version, dockerSocket: this.#config.dockerSocket, protectedUnits: this.#config.protectedUnits, protectedContainers: this.#config.protectedContainers, internetCheckTargets: this.#config.internetCheckTargets, ...this.#files })}\n`,
    );
    return worker;
  }

  async *#run(op: string, params: unknown, context: OperationContext): AsyncGenerator<unknown> {
    if (context.actor.kind !== "user") throw new OperationError("forbidden", "User required");
    const worker = this.#worker(context.actor, this.#identities.resolve(context.actor));
    const id = ++this.#sequence;
    const pending: Pending = { frames: [], done: false, wake: () => undefined };
    worker.pending.set(id, pending);
    worker.at = Date.now();
    const cancel = () => {
      pending.done = true;
      pending.wake();
      worker.child.stdin.write(`${JSON.stringify({ cancel: id })}\n`);
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (context.signal.aborted) return;
      worker.child.stdin.write(`${JSON.stringify({ id, op, params, actor: context.actor })}\n`);
      while (!context.signal.aborted) {
        while (pending.frames.length) {
          const frame = pending.frames.shift();
          if (
            frame !== null ||
            AGENT_OPERATIONS[op as keyof typeof AGENT_OPERATIONS].kind === "unary"
          )
            yield frame;
        }
        if (pending.error) throw pending.error;
        if (pending.done) break;
        await new Promise<void>((resolve) => {
          pending.wake = resolve;
        });
      }
    } finally {
      context.signal.removeEventListener("abort", cancel);
      worker.pending.delete(id);
      worker.at = Date.now();
      if (!pending.done) cancel();
    }
  }
}
