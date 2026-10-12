import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import type { TerminalServerMessage } from "@everyos/shared";
import { describe, expect, it } from "vitest";
import { attachTerminalGateway, authorizeUpgrade } from "./modules/terminal/gateway.ts";
import { TerminalService, type TerminalViewer } from "./modules/terminal/terminal-service.ts";
import {
  TEST_HOST,
  TEST_ORIGIN,
  withRoles,
  type TestClient,
  type TestContext,
} from "./test-support.ts";

/** Minimal stand-in for a `ws` WebSocket. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<string | Buffer> = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close", code, Buffer.from(reason));
  }
  type(text: string) {
    this.emit("message", Buffer.from(text), true);
  }
  control(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  messages(): TerminalServerMessage[] {
    return this.sent
      .filter((m): m is string => typeof m === "string")
      .map((m) => JSON.parse(m) as TerminalServerMessage);
  }
  output(): string {
    return this.sent
      .filter((m): m is Buffer => Buffer.isBuffer(m))
      .map((m) => m.toString("utf8"))
      .join("");
  }
}

/** Echoing fake shell: input is written back; "exit" ends the session with code 0. */
function fakeShell(
  ctx: TestContext,
  status = { enabled: true as const, user: "pi", shell: "/bin/bash" },
) {
  const sessions = new Map<string, { push: (event: unknown) => void }>();
  ctx.agent.handlers.set("terminal.status", () => status);
  ctx.agent.handlers.set("terminal.input", (params) => {
    const { sessionId, data } = params as { sessionId: string; data: string };
    const text = Buffer.from(data, "base64").toString("utf8");
    const session = sessions.get(sessionId);
    if (text.trim() === "exit") session?.push({ type: "exit", code: 0 });
    else session?.push({ type: "output", data: Buffer.from(`$ ${text}`).toString("base64") });
    return { accepted: true };
  });
  ctx.agent.handlers.set("terminal.resize", () => ({ accepted: true }));
  ctx.agent.handlers.set("terminal.close", () => ({ closed: true }));
  ctx.agent.streamHandlers.set("terminal.open", async function* (params, signal) {
    const { sessionId } = params as { sessionId: string };
    const queue: unknown[] = [{ type: "started", user: status.user, shell: status.shell }];
    let wake: (() => void) | null = null;
    sessions.set(sessionId, {
      push: (event) => {
        queue.push(event);
        wake?.();
      },
    });
    while (!signal.aborted) {
      while (queue.length > 0) {
        const event = queue.shift() as { type: string };
        yield event;
        if (event.type === "exit") return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function viewerOf(ctx: TestContext, username: string): TerminalViewer {
  const user = ctx.db.get<{ id: string; role: TerminalViewer["role"] }>(
    "SELECT id, role FROM users WHERE username = ?",
    username,
  )!;
  return { userId: user.id, username, role: user.role, sessionId: "s1", ip: "127.0.0.1" };
}

function upgradeRequest(client: TestClient, headers: Record<string, string> = {}) {
  return {
    headers: {
      host: TEST_HOST,
      origin: TEST_ORIGIN,
      cookie: [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      ...headers,
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Parameters<typeof authorizeUpgrade>[1];
}

describe("terminal gateway", () => {
  it("rejects malformed upgrade URLs without throwing outside HTTP middleware", async () => {
    const { ctx, admin } = await withRoles();
    const server = createServer();
    const detach = attachTerminalGateway(server, ctx.services);
    const peer = new PassThrough();
    peer.setEncoding("utf8");
    try {
      expect(() =>
        server.emit(
          "upgrade",
          { ...upgradeRequest(admin), url: "http://%" },
          peer,
          Buffer.alloc(0),
        ),
      ).not.toThrow();
      expect(peer.read() as string).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    } finally {
      detach();
      peer.destroy();
    }
  });
  it("authorizes upgrades like ordinary requests and refuses foreign origins", async () => {
    const { ctx, admin, operator } = await withRoles();
    expect(authorizeUpgrade(ctx.services, upgradeRequest(admin))).toMatchObject({
      viewer: { username: "admin", role: "admin" },
    });
    // Cross-site WebSocket hijacking: the browser sends the attacker's origin.
    expect(
      authorizeUpgrade(ctx.services, upgradeRequest(admin, { origin: "https://evil.example" })),
    ).toEqual({
      status: 403,
    });
    expect(authorizeUpgrade(ctx.services, upgradeRequest(admin, { origin: "" }))).toEqual({
      status: 403,
    });
    expect(authorizeUpgrade(ctx.services, upgradeRequest(admin, { cookie: "" }))).toEqual({
      status: 401,
    });
    // Operators have no terminal:access by default.
    expect(authorizeUpgrade(ctx.services, upgradeRequest(operator))).toEqual({ status: 403 });
    await admin.post("/api/auth/lock");
    expect(authorizeUpgrade(ctx.services, upgradeRequest(admin))).toEqual({ status: 423 });
  });

  it("rejects malformed cookie encoding without throwing in the upgrade listener", async () => {
    const { ctx, admin } = await withRoles();
    const name = [...admin.cookies.keys()][0]!;
    expect(authorizeUpgrade(ctx.services, upgradeRequest(admin, { cookie: `${name}=%` }))).toEqual({
      status: 401,
    });
  });

  it("requires terminal access for the HTTP routes", async () => {
    const { ctx, admin, operator } = await withRoles();
    fakeShell(ctx);
    expect((await operator.get("/api/terminal/status")).status).toBe(403);
    expect(await (await admin.get("/api/terminal/status")).json()).toEqual({
      enabled: true,
      user: "pi",
      shell: "/bin/bash",
    });
    expect(await (await admin.get("/api/terminal/sessions")).json()).toEqual({ sessions: [] });
  });
});

describe("terminal sessions", () => {
  async function service(limits: ConstructorParameters<typeof TerminalService>[0]["limits"] = {}) {
    const roles = await withRoles();
    fakeShell(roles.ctx);
    const terminals = new TerminalService({
      agent: roles.ctx.agent,
      logger: roles.ctx.services.logger,
      audit: roles.ctx.services.audit,
      now: () => roles.ctx.clock.now,
      limits: { graceMs: 50, idleMs: 60_000, ...limits },
    });
    return { ...roles, terminals, admin: viewerOf(roles.ctx, "admin") };
  }

  it("does not start a shell if the socket closes while status is pending", async () => {
    const { ctx, terminals, admin } = await service();
    let release: (() => void) | undefined;
    ctx.agent.handlers.set(
      "terminal.status",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ enabled: true, user: "pi", shell: "/bin/bash" });
        }),
    );
    const socket = new FakeSocket();
    const pending = terminals.connect(socket as never, admin, { cols: 80, rows: 24 });
    socket.close(1001, "window closed");
    release!();
    await pending;
    try {
      expect(terminals.sessions()).toEqual([]);
      expect(ctx.agent.calls.some((call) => call.op === "terminal.open")).toBe(false);
    } finally {
      terminals.stop();
    }
  });

  it.each([
    { perUser: 2, total: 12 },
    { perUser: 4, total: 2 },
  ])("enforces limits for simultaneous openings: %j", async (limits) => {
    const { ctx, terminals, admin } = await service(limits);
    const releases: Array<() => void> = [];
    ctx.agent.handlers.set(
      "terminal.status",
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ enabled: true, user: "pi", shell: "/bin/bash" }));
        }),
    );
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    const pending = sockets.map((socket) =>
      terminals.connect(socket as never, admin, { cols: 80, rows: 24 }),
    );
    for (const release of releases) release();
    await Promise.all(pending);
    try {
      expect(terminals.sessions()).toHaveLength(2);
      expect(sockets[2]!.closed?.code).toBe(4429);
    } finally {
      terminals.stop();
    }
  });

  it("ends immediately when the window signals closure before receiving its id", async () => {
    const { terminals, admin } = await service({ graceMs: 2_000 });
    const socket = new FakeSocket();
    await terminals.connect(socket as never, admin, { cols: 80, rows: 24 });
    try {
      socket.close(4000, "window closed");
      expect(terminals.sessions()).toEqual([]);
    } finally {
      terminals.stop();
    }
  });

  it("relays input and output, resizes, and ends with the shell", async () => {
    const { ctx, terminals, admin } = await service();
    const socket = new FakeSocket();
    await terminals.connect(socket as never, admin, { cols: 100, rows: 30 });
    await settle();
    expect(socket.messages()[0]).toMatchObject({ type: "ready", account: "pi", resumed: false });
    socket.type("ls\n");
    await settle();
    expect(socket.output()).toContain("$ ls");
    socket.control({ type: "resize", cols: 120, rows: 40 });
    socket.control({ type: "resize", cols: 9999, rows: 40 }); // invalid sizes are ignored
    await settle();
    expect(ctx.agent.calls.filter((c) => c.op === "terminal.resize").map((c) => c.params)).toEqual([
      expect.objectContaining({ cols: 120, rows: 40 }),
    ]);
    socket.type("exit\n");
    await settle();
    expect(socket.messages().at(-1)).toEqual({ type: "exit", reason: "exited", code: 0 });
    expect(socket.closed?.code).toBe(4000);
    expect(terminals.sessions()).toEqual([]);
    const audit = ctx.db.all<{ action: string; target: string }>(
      "SELECT action, target FROM audit_events WHERE action LIKE 'terminal.%' ORDER BY id",
    );
    expect(audit).toEqual([
      { action: "terminal.open", target: "pi" },
      { action: "terminal.close", target: "pi" },
    ]);
  });

  it("survives a short disconnect, replays output and lets only the owner resume", async () => {
    const { ctx, terminals, admin } = await service({ graceMs: 2_000 });
    const first = new FakeSocket();
    await terminals.connect(first as never, admin, { cols: 80, rows: 24 });
    await settle(); // Input is accepted only after the account PTY is ready.
    first.type("echo merhaba\n");
    await settle();
    const id = terminals.sessions()[0]!.id;
    first.close(1001, "page reload");
    expect(terminals.sessions()[0]).toMatchObject({ id, attached: false });

    const stranger = new FakeSocket();
    await terminals.connect(
      stranger as never,
      { ...viewerOf(ctx, "operator"), sessionId: "s2" },
      {
        resume: id,
        cols: 80,
        rows: 24,
      },
    );
    expect(stranger.closed?.code).toBe(4404);

    const again = new FakeSocket();
    await terminals.connect(again as never, admin, { resume: id, cols: 80, rows: 24 });
    expect(again.messages()[0]).toMatchObject({ type: "ready", sessionId: id, resumed: true });
    expect(again.output()).toContain("$ echo merhaba");
    // A newer tab takes over the session.
    const third = new FakeSocket();
    await terminals.connect(third as never, admin, { resume: id, cols: 80, rows: 24 });
    expect(again.closed?.code).toBe(4409);
    terminals.stop();
  });

  it("ends abandoned and idle sessions, limits concurrency and honours revocation", async () => {
    const { ctx, terminals, admin } = await service({ graceMs: 30, idleMs: 80, perUser: 2 });
    const a = new FakeSocket();
    await terminals.connect(a as never, admin, { cols: 80, rows: 24 });
    a.close(1006, "network");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(terminals.sessions()).toEqual([]);

    const idle = new FakeSocket();
    await terminals.connect(idle as never, admin, { cols: 80, rows: 24 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(idle.messages().at(-1)).toMatchObject({ type: "exit", reason: "idle" });

    const one = new FakeSocket();
    const two = new FakeSocket();
    const three = new FakeSocket();
    await terminals.connect(one as never, admin, { cols: 80, rows: 24 });
    await terminals.connect(two as never, admin, { cols: 80, rows: 24 });
    await terminals.connect(three as never, admin, { cols: 80, rows: 24 });
    expect(three.closed?.code).toBe(4429);

    terminals.revalidate(() => false);
    expect(one.messages().at(-1)).toMatchObject({ type: "exit", reason: "revoked" });
    expect(terminals.sessions()).toEqual([]);

    ctx.agent.handlers.set("terminal.status", () => ({ enabled: false, reason: "not-configured" }));
    const disabled = new FakeSocket();
    await terminals.connect(disabled as never, admin, { cols: 80, rows: 24 });
    expect(disabled.closed).toEqual({ code: 4403, reason: "not-configured" });
  });
});
