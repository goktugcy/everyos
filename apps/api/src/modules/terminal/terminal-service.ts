import { randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import type {
  Role,
  TerminalServerMessage,
  TerminalSessionView,
  TerminalStatus,
} from "@everyos/shared";
import { TerminalClientMessageSchema } from "@everyos/shared/schemas";
import type { WebSocket } from "ws";
import type { AuditLog } from "../audit/audit-log.ts";
import type { AgentGateway } from "../../services.ts";

/** Who is connecting, as established by the upgrade check. */
export interface TerminalViewer {
  userId: string;
  username: string;
  role: Role;
  /** Browser session; access is re-checked against it while connected. */
  sessionId: string;
  ip: string;
}

interface Session {
  id: string;
  owner: TerminalViewer;
  account: string;
  shell: string;
  startedAt: number;
  lastInputAt: number;
  socket: WebSocket | null;
  scrollback: Buffer[];
  scrollbackBytes: number;
  controller: AbortController;
  graceTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  ended: boolean;
}

export interface TerminalLimits {
  /** No keystrokes for this long ends the session. */
  idleMs: number;
  /** A disconnected browser can reattach within this window. */
  graceMs: number;
  perUser: number;
  total: number;
  scrollbackBytes: number;
}

export const DEFAULT_TERMINAL_LIMITS: TerminalLimits = {
  idleMs: 30 * 60_000,
  graceMs: 60_000,
  perUser: 4,
  total: 12,
  scrollbackBytes: 256 * 1024,
};

/** WebSocket close codes (4000–4999 are application defined). */
export const TERMINAL_CLOSE = {
  disabled: 4403,
  notFound: 4404,
  limit: 4429,
  replaced: 4409,
  ended: 4000,
} as const;

/**
 * Browser terminal sessions (docs/terminal.md). The API keeps sessions alive
 * across short disconnects (scrollback is replayed on reattach), ends them
 * after idle time or when access is revoked, and audits opening and closing.
 * The shell itself runs in the agent, as the account the agent is configured
 * for.
 */
export class TerminalService {
  readonly #agent: AgentGateway;
  readonly #logger: Logger;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #limits: TerminalLimits;
  readonly #sessions = new Map<string, Session>();

  constructor(deps: {
    agent: AgentGateway;
    logger: Logger;
    audit: AuditLog;
    now: () => number;
    limits?: Partial<TerminalLimits>;
  }) {
    this.#agent = deps.agent;
    this.#logger = deps.logger.child({ component: "terminal" });
    this.#audit = deps.audit;
    this.#now = deps.now;
    this.#limits = { ...DEFAULT_TERMINAL_LIMITS, ...deps.limits };
  }

  async status(viewer: TerminalViewer): Promise<TerminalStatus> {
    return this.#agent.call("terminal.status", {}, this.#actor(viewer));
  }

  sessions(userId?: string): TerminalSessionView[] {
    return [...this.#sessions.values()]
      .filter((s) => !s.ended && (userId === undefined || s.owner.userId === userId))
      .map((s) => ({
        id: s.id,
        userId: s.owner.userId,
        username: s.owner.username,
        account: s.account,
        startedAt: s.startedAt,
        lastInputAt: s.lastInputAt,
        attached: s.socket !== null,
      }));
  }

  /** Attaches a browser to a new or (`resume`) existing session of the same user. */
  async connect(
    socket: WebSocket,
    viewer: TerminalViewer,
    options: { resume?: string | undefined; cols: number; rows: number },
  ): Promise<void> {
    if (options.resume) {
      const session = this.#sessions.get(options.resume);
      if (!session || session.ended || session.owner.userId !== viewer.userId) {
        socket.close(TERMINAL_CLOSE.notFound, "session not found");
        return;
      }
      session.owner = viewer;
      this.#attach(session, socket, true);
      this.#resize(session, options.cols, options.rows);
      return;
    }
    const mine = this.sessions(viewer.userId).length;
    if (mine >= this.#limits.perUser || this.sessions().length >= this.#limits.total) {
      socket.close(TERMINAL_CLOSE.limit, "too many sessions");
      return;
    }
    let status: TerminalStatus;
    try {
      status = await this.status(viewer);
    } catch {
      socket.close(TERMINAL_CLOSE.disabled, "agent unavailable");
      return;
    }
    if (!status.enabled) {
      socket.close(TERMINAL_CLOSE.disabled, status.reason);
      return;
    }
    // Status awaits the agent: the browser can leave and other openings can
    // consume the quota before it returns. Check both before creating a shell.
    if (socket.readyState !== 1) return;
    if (
      this.sessions(viewer.userId).length >= this.#limits.perUser ||
      this.sessions().length >= this.#limits.total
    ) {
      socket.close(TERMINAL_CLOSE.limit, "too many sessions");
      return;
    }
    const session: Session = {
      id: randomUUID(),
      owner: viewer,
      account: status.user,
      shell: status.shell,
      startedAt: this.#now(),
      lastInputAt: this.#now(),
      socket: null,
      scrollback: [],
      scrollbackBytes: 0,
      controller: new AbortController(),
      graceTimer: null,
      idleTimer: null,
      ended: false,
    };
    this.#sessions.set(session.id, session);
    this.#audit.record({
      action: "terminal.open",
      outcome: "success",
      actor: { userId: viewer.userId, username: viewer.username },
      ip: viewer.ip,
      target: session.account,
      details: { sessionId: session.id },
    });
    void this.#run(session, options.cols, options.rows);
    this.#attach(session, socket, false);
  }

  /** Ends a session (its owner, an administrator, or the server). */
  terminate(
    id: string,
    reason: "closed" | "idle" | "revoked" | "error",
    by?: TerminalViewer,
  ): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.ended) return false;
    this.#end(session, reason, null, by);
    return true;
  }

  /** Re-checks access of connected browsers; `allowed` answers for a browser session. */
  revalidate(allowed: (viewer: TerminalViewer) => boolean): void {
    for (const session of this.#sessions.values())
      if (!session.ended && !allowed(session.owner)) this.#end(session, "revoked", null);
  }

  stop(): void {
    for (const session of this.#sessions.values()) this.#end(session, "closed", null);
  }

  async #run(session: Session, cols: number, rows: number): Promise<void> {
    let code: number | null = null;
    try {
      for await (const event of this.#agent.stream(
        "terminal.open",
        { sessionId: session.id, cols, rows },
        this.#actor(session.owner),
        { signal: session.controller.signal },
      )) {
        if (event.type === "output") this.#output(session, Buffer.from(event.data, "base64"));
        else if (event.type === "exit") code = event.code;
      }
      this.#end(session, "exited", code);
    } catch (error) {
      if (!session.ended) {
        this.#logger.warn("Terminal stream ended with an error", { sessionId: session.id, error });
        this.#end(session, "error", null);
      }
    }
  }

  #attach(session: Session, socket: WebSocket, resumed: boolean): void {
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;
    // One browser per session: a newer tab takes over.
    if (session.socket && session.socket !== socket)
      session.socket.close(TERMINAL_CLOSE.replaced, "opened elsewhere");
    session.socket = socket;
    this.#send(session, {
      type: "ready",
      sessionId: session.id,
      account: session.account,
      shell: session.shell,
      resumed,
    });
    for (const chunk of session.scrollback) socket.send(chunk, { binary: true });
    this.#touch(session);

    socket.on("message", (data, binary) => {
      if (session.ended || session.socket !== socket) return;
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (binary) {
        this.#touch(session);
        this.#agent
          .call(
            "terminal.input",
            { sessionId: session.id, data: buffer.subarray(0, 64 * 1024).toString("base64") },
            this.#actor(session.owner),
          )
          .catch(() => undefined);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(buffer.toString("utf8"));
      } catch {
        return;
      }
      const parsed = TerminalClientMessageSchema.safeParse(message);
      if (parsed.success) this.#resize(session, parsed.data.cols, parsed.data.rows);
    });
    socket.on("close", (code: number) => {
      if (session.socket !== socket) return;
      session.socket = null;
      if (session.ended) return;
      if (code === TERMINAL_CLOSE.ended) {
        this.#end(session, "closed", null);
        return;
      }
      session.graceTimer = setTimeout(
        () => this.#end(session, "closed", null),
        this.#limits.graceMs,
      );
      session.graceTimer.unref();
    });
  }

  #output(session: Session, chunk: Buffer): void {
    session.scrollback.push(chunk);
    session.scrollbackBytes += chunk.length;
    while (session.scrollbackBytes > this.#limits.scrollbackBytes && session.scrollback.length > 1)
      session.scrollbackBytes -= session.scrollback.shift()!.length;
    if (session.socket?.readyState === 1) session.socket.send(chunk, { binary: true });
  }

  #resize(session: Session, cols: number, rows: number): void {
    this.#agent
      .call("terminal.resize", { sessionId: session.id, cols, rows }, this.#actor(session.owner))
      .catch(() => undefined);
  }

  #touch(session: Session): void {
    session.lastInputAt = this.#now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.#end(session, "idle", null), this.#limits.idleMs);
    session.idleTimer.unref();
  }

  #send(session: Session, message: TerminalServerMessage): void {
    if (session.socket?.readyState === 1) session.socket.send(JSON.stringify(message));
  }

  #end(
    session: Session,
    reason: Extract<TerminalServerMessage, { type: "exit" }>["reason"],
    code: number | null,
    by?: TerminalViewer,
  ): void {
    if (session.ended) return;
    session.ended = true;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.#send(session, { type: "exit", reason, code });
    session.socket?.close(TERMINAL_CLOSE.ended, reason);
    session.controller.abort();
    this.#agent
      .call("terminal.close", { sessionId: session.id }, this.#actor(by ?? session.owner))
      .catch(() => undefined);
    this.#sessions.delete(session.id);
    const actor = by ?? session.owner;
    this.#audit.record({
      action: "terminal.close",
      outcome: "success",
      actor: { userId: actor.userId, username: actor.username },
      ip: actor.ip,
      target: session.account,
      details: { sessionId: session.id, reason, owner: session.owner.username, code },
    });
  }

  #actor(viewer: TerminalViewer): Actor {
    return {
      kind: "user",
      userId: viewer.userId,
      username: viewer.username,
      role: viewer.role,
      sessionId: viewer.sessionId,
      ip: viewer.ip.slice(0, 64),
    };
  }
}
