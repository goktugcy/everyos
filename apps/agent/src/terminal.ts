import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { Writable } from "node:stream";
import { OperationError, type Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import type { TerminalStatus } from "@everyos/shared";

/** agent.yaml `terminal:` — the terminal stays disabled until an account is configured. */
export interface TerminalConfig {
  /** Linux account the shell runs as. */
  user: string;
  /** Login shell; defaults to the account's shell from /etc/passwd. */
  shell?: string | undefined;
  /** Root shells must be allowed explicitly. */
  allowRoot: boolean;
  /** Python 3 interpreter that provides the pseudo-terminal (absolute path). */
  python: string;
}

interface Account {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

const MAX_SESSIONS = 16;
/** Output buffered before the relay is paused (backpressure towards the shell). */
const HIGH_WATER_BYTES = 256 * 1024;

/**
 * Pseudo-terminal relay. Started as root it drops to the account (with its
 * supplementary groups) before anything else; it relays stdin → pty and
 * pty → stdout, and takes JSON resize lines on fd 3. Exit code: the shell's.
 */
const RELAY = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios
cfg = json.loads(sys.argv[1])
if os.getuid() == 0:
    os.initgroups(cfg["user"], cfg["gid"])
    os.setgid(cfg["gid"])
    os.setuid(cfg["uid"])
if os.getuid() != cfg["uid"]:
    sys.exit(126)
env = {
    "HOME": cfg["home"], "USER": cfg["user"], "LOGNAME": cfg["user"], "SHELL": cfg["shell"],
    "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": cfg["lang"],
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
}
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(cfg["home"])
    except OSError:
        os.chdir("/")
    os.execve(cfg["shell"], ["-" + os.path.basename(cfg["shell"])], env)
def winsize(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
winsize(cfg["rows"], cfg["cols"])
def stop(*_):
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    os._exit(129)
signal.signal(signal.SIGTERM, stop)
def write_all(target, data):
    while data:
        data = data[os.write(target, data):]
watch, pending = [fd, 0, 3], b""
while True:
    try:
        ready = select.select(watch, [], [])[0]
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            write_all(fd, data)
        else:
            watch.remove(0)
            stop()
    if 3 in ready:
        chunk = os.read(3, 4096)
        if not chunk:
            watch.remove(3)
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                size = json.loads(line)
                winsize(max(2, min(300, int(size["rows"]))), max(2, min(500, int(size["cols"]))))
            except (ValueError, KeyError, TypeError, OSError):
                pass
status = os.waitpid(pid, 0)[1]
code = os.waitstatus_to_exitcode(status)
os._exit(code if code >= 0 else 128 - code)
`;

function readAccounts(): Map<string, Account> {
  const accounts = new Map<string, Account>();
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const [name, , uid, gid, , home, shell] = line.split(":");
      if (name && uid && gid && home !== undefined && shell)
        accounts.set(name, { name, uid: Number(uid), gid: Number(gid), home, shell });
    }
  } catch {
    // Not every platform has /etc/passwd entries for real users (macOS).
  }
  return accounts;
}

interface Session {
  id: string;
  ownerId: string;
  child: ChildProcess;
  control: Writable;
}

/**
 * Terminal sessions (docs/terminal.md). The agent decides *who* the shell
 * runs as; the API only decides who may open one. Disabled until
 * `terminal.user` is configured; a root account additionally needs
 * `allowRoot: true`.
 */
export class TerminalManager {
  readonly #config: TerminalConfig | null;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, Session>();
  readonly #lang: string;

  constructor(options: { config: TerminalConfig | null; logger: Logger; lang?: string }) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: "terminal" });
    this.#lang = options.lang ?? "C.UTF-8";
  }

  status(): TerminalStatus {
    const resolved = this.#resolve();
    return "reason" in resolved
      ? { enabled: false, reason: resolved.reason }
      : { enabled: true, user: resolved.account.name, shell: resolved.account.shell };
  }

  async *open(
    params: { sessionId: string; cols: number; rows: number },
    actor: Actor,
    signal: AbortSignal,
  ): AsyncGenerator<
    | { type: "started"; user: string; shell: string }
    | { type: "output"; data: string }
    | { type: "exit"; code: number | null }
  > {
    if (actor.kind !== "user")
      throw new OperationError("forbidden", "Terminals are opened by users");
    const resolved = this.#resolve();
    if ("reason" in resolved)
      throw new OperationError("unsupported", `${resolved.reason}: terminal is disabled`);
    if (this.#sessions.size >= MAX_SESSIONS)
      throw new OperationError("busy", "Too many terminal sessions");
    if (this.#sessions.has(params.sessionId))
      throw new OperationError("conflict", "Session id in use");
    const { account, python } = resolved;

    const child = spawn(
      python,
      [
        "-I",
        "-c",
        RELAY,
        JSON.stringify({
          user: account.name,
          uid: account.uid,
          gid: account.gid,
          home: account.home,
          shell: account.shell,
          lang: this.#lang,
          cols: params.cols,
          rows: params.rows,
        }),
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } },
    );
    const control = child.stdio[3] as Writable;
    const session: Session = { id: params.sessionId, ownerId: actor.userId, child, control };
    this.#sessions.set(session.id, session);
    this.#logger.info("Terminal opened", {
      sessionId: session.id,
      actorUser: actor.username,
      account: account.name,
    });

    const queue: Buffer[] = [];
    let queued = 0;
    let exited: number | null | undefined;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      queue.push(chunk);
      queued += chunk.length;
      if (queued > HIGH_WATER_BYTES) child.stdout.pause();
      notify();
    });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 2_000) errors += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      this.#logger.warn("Terminal relay failed to start", { error });
      exited = null;
      notify();
    });
    child.on("close", (code) => {
      exited = code;
      notify();
    });
    const onAbort = () => this.#kill(child);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      yield { type: "started", user: account.name, shell: account.shell };
      while (true) {
        while (queue.length > 0) {
          // At most 48 KiB per event keeps frames well below the protocol limit.
          let chunk = queue.shift()!;
          if (chunk.length > 48 * 1024) {
            queue.unshift(chunk.subarray(48 * 1024));
            chunk = chunk.subarray(0, 48 * 1024);
          }
          queued -= chunk.length;
          if (queued <= HIGH_WATER_BYTES / 2) child.stdout.resume();
          yield { type: "output", data: chunk.toString("base64") };
        }
        if (exited !== undefined) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length > 0 || exited !== undefined) resolve();
        });
      }
      if (exited !== 0 && errors.trim())
        this.#logger.warn("Terminal relay reported an error", {
          sessionId: session.id,
          stderr: errors.trim(),
        });
      yield { type: "exit", code: exited ?? null };
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#kill(child);
      this.#sessions.delete(session.id);
      this.#logger.info("Terminal closed", { sessionId: session.id, code: exited ?? null });
    }
  }

  input(sessionId: string, data: string, actor: Actor): void {
    const session = this.#owned(sessionId, actor);
    session.child.stdin?.write(Buffer.from(data, "base64"));
  }

  resize(sessionId: string, cols: number, rows: number, actor: Actor): void {
    const session = this.#owned(sessionId, actor);
    session.control.write(`${JSON.stringify({ cols, rows })}\n`);
  }

  /** Any terminal-capable user may end a session (administrators ending others' sessions). */
  close(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    this.#kill(session.child);
    return true;
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) this.#kill(session.child);
  }

  #owned(sessionId: string, actor: Actor): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new OperationError("not_found", "No such terminal session");
    if (actor.kind !== "user" || actor.userId !== session.ownerId)
      throw new OperationError("forbidden", "This terminal belongs to another user");
    return session;
  }

  #kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    timer.unref();
  }

  #resolve():
    | { account: Account; python: string }
    | { reason: "not-configured" | "user-missing" | "root-refused" | "python-missing" } {
    const config = this.#config;
    if (!config) return { reason: "not-configured" };
    let account = readAccounts().get(config.user);
    // Development on macOS: the agent's own account, which /etc/passwd may not list.
    if (!account && config.user === (process.env.USER ?? "") && process.getuid?.() !== 0) {
      account = {
        name: config.user,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        home: process.env.HOME ?? "/",
        shell: process.env.SHELL ?? "/bin/sh",
      };
    }
    if (!account) return { reason: "user-missing" };
    if (account.uid === 0 && !config.allowRoot) return { reason: "root-refused" };
    const shell = config.shell ?? account.shell;
    try {
      if (!statSync(config.python).isFile()) return { reason: "python-missing" };
    } catch {
      return { reason: "python-missing" };
    }
    return { account: { ...account, shell }, python: config.python };
  }
}
