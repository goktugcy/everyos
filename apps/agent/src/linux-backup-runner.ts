import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { SAFE_ENV } from "@everyos/system";

export interface BorgInvocation {
  binary: string;
  args: string[];
  cwd: string;
  state: string;
  passphrase: string;
  signal?: AbortSignal;
  progress?: (value: Record<string, unknown>) => void;
  timeoutMs?: number;
}

/** Fixed Borg invocations only. The passphrase travels through an anonymous pipe, never argv/env. */
export function runBorg(input: BorgInvocation): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: {
        ...SAFE_ENV,
        TZ: "UTC",
        HOME: input.state,
        BORG_BASE_DIR: input.state,
        BORG_CACHE_DIR: `${input.state}/cache`,
        BORG_SECURITY_DIR: `${input.state}/security`,
        BORG_KEYS_DIR: `${input.state}/keys`,
        BORG_CONFIG_DIR: `${input.state}/config`,
        BORG_PASSPHRASE_FD: "3",
        BORG_EXIT_CODES: "legacy",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const password = child.stdio[3] as Writable;
    password.on("error", () => undefined);
    password.end(input.passphrase + "\n");
    let output = "";
    let pending = "";
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      child.kill("SIGINT");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
      killTimer.unref();
    };
    const timeout = setTimeout(
      () => {
        failure = new Error("BORG_TIMEOUT");
        abort();
      },
      input.timeoutMs ?? 24 * 60 * 60_000,
    );
    timeout.unref();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdout!.on("data", (bytes: Buffer) => {
      if (failure) return;
      output += bytes.toString("utf8");
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) {
        failure = new Error("BORG_OUTPUT_LIMIT");
        abort();
      }
    });
    child.stderr!.on("data", (bytes: Buffer) => {
      pending += bytes.toString("utf8");
      if (pending.length > 65_536) pending = pending.slice(-65_536);
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (value && typeof value === "object" && !Array.isArray(value))
            input.progress?.(value as Record<string, unknown>);
        } catch {
          /* Never forward raw paths or diagnostics to logs or the browser. */
        }
      }
    });
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", abort);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("BORG_START_FAILED"));
    });
    child.once("close", (code) => {
      cleanup();
      if (input.signal?.aborted) reject(new Error("BORG_CANCELLED"));
      else if (failure) reject(failure);
      else resolve({ code: code ?? 2, output });
    });
  });
}
