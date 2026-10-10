import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createInterface } from "node:readline";

/*
 * Controlled command execution for the agent. Commands are never run through
 * a shell, always by absolute path, with a fixed minimal environment, a hard
 * timeout and an output size cap. Arguments are passed as an array, so user
 * input can never be interpreted as shell syntax.
 */

export type CommandErrorKind = "not-found" | "timeout" | "aborted" | "failed" | "too-large";

export class CommandError extends Error {
  readonly kind: CommandErrorKind;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    kind: CommandErrorKind,
    message: string,
    exitCode: number | null = null,
    stderr = "",
  ) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
    this.exitCode = exitCode;
    this.stderr = stderr.slice(0, 2000);
  }
}

export const SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  SYSTEMD_PAGER: "",
  SYSTEMD_COLORS: "0",
  SYSTEMD_LESS: "",
};

const SEARCH_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/vc/bin",
];
const executableCache = new Map<string, string | null>();

/** Absolute path of a trusted system tool, or null when it is not installed. */
export async function findExecutable(name: string): Promise<string | null> {
  if (executableCache.has(name)) return executableCache.get(name)!;
  let found: string | null = null;
  for (const dir of SEARCH_DIRS) {
    try {
      await access(`${dir}/${name}`, constants.X_OK);
      found = `${dir}/${name}`;
      break;
    } catch {
      // Try the next directory.
    }
  }
  executableCache.set(name, found);
  return found;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Exit codes treated as success (systemctl uses 3 for "inactive"). */
  okExitCodes?: readonly number[];
}

export function runCommand(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env: SAFE_ENV,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBytes ?? 8 * 1024 * 1024,
        killSignal: "SIGKILL",
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          code?: unknown;
          killed?: boolean;
          signal?: string;
        };
        if (err.code === "ENOENT")
          reject(new CommandError("not-found", `${file} is not installed`));
        else if (err.name === "AbortError")
          reject(new CommandError("aborted", `${file} was aborted`));
        else if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          reject(new CommandError("too-large", `${file} produced too much output`));
        else if (err.killed && err.signal === "SIGKILL")
          reject(new CommandError("timeout", `${file} timed out`));
        else if (typeof err.code === "number" && (options.okExitCodes ?? []).includes(err.code))
          resolve(stdout);
        else
          reject(
            new CommandError(
              "failed",
              `${file} failed`,
              typeof err.code === "number" ? err.code : null,
              stderr,
            ),
          );
      },
    );
  });
}

/**
 * Streams a long-running command's stdout line by line (e.g. `journalctl -f`).
 * The process is killed when the consumer stops iterating or `signal` aborts.
 */
export async function* streamLines(
  file: string,
  args: readonly string[],
  options: { signal?: AbortSignal; maxLineBytes?: number } = {},
): AsyncGenerator<string> {
  const child = spawn(file, [...args], {
    env: SAFE_ENV,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", kill, { once: true });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT" ? new CommandError("not-found", `${file} is not installed`) : error,
      ),
    );
  });
  spawnError.catch(() => undefined);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const max = options.maxLineBytes ?? 64 * 1024;
  try {
    const iterator = lines[Symbol.asyncIterator]();
    while (!options.signal?.aborted) {
      const next = await Promise.race([iterator.next(), spawnError]);
      // Lines already buffered by readline must not leak out after an abort.
      if (next.done || options.signal?.aborted) break;
      yield next.value.length > max ? next.value.slice(0, max) : next.value;
    }
  } finally {
    options.signal?.removeEventListener("abort", kill);
    lines.close();
    kill();
  }
}

export interface CaptureResult {
  exitCode: number | null;
  /** The tail of stdout and stderr interleaved, at most `maxOutputBytes`. */
  output: string;
}

/**
 * Runs a long tool (e.g. `docker compose up`) and keeps only the end of its
 * combined output. A non-zero exit is a normal result, not an exception;
 * missing tools, timeouts and aborts still throw `CommandError`.
 */
export function runCapture(
  file: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    cwd?: string;
    maxOutputBytes?: number;
  },
): Promise<CaptureResult> {
  if (options.signal?.aborted)
    return Promise.reject(new CommandError("aborted", `${file} was aborted`));
  const max = options.maxOutputBytes ?? 16 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      env: options.env ?? SAFE_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let tail = Buffer.alloc(0);
    const collect = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > max * 2) tail = tail.subarray(tail.length - max);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let failure: CommandError | null = null;
    const stop = (error: CommandError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new CommandError("timeout", `${file} timed out`)),
      options.timeoutMs,
    );
    const onAbort = () => stop(new CommandError("aborted", `${file} was aborted`));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        error.code === "ENOENT" ? new CommandError("not-found", `${file} is not installed`) : error,
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else
        resolve({
          exitCode: code,
          output: tail.subarray(Math.max(0, tail.length - max)).toString("utf8"),
        });
    });
  });
}
