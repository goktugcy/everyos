import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemInfo } from "@otuken/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentClient,
  AgentClientError,
  AgentServer,
  encodeFrame,
  FrameTooLargeError,
  isActorAuthorized,
  LineDecoder,
  OperationError,
  type Actor,
  type OperationHandlers,
} from "./index.ts";

const agentKey = Buffer.alloc(32, 3);
const admin: Actor = { kind: "user", userId: "u1", username: "admin", role: "admin" };
const viewer: Actor = { kind: "user", userId: "u2", username: "viewer", role: "viewer" };

const sampleInfo: SystemInfo = {
  source: "host",
  hostname: "pi5",
  platform: "linux",
  arch: "arm64",
  kernel: "6.12.0",
  os: { id: "ubuntu", name: "Ubuntu", version: "24.04", prettyName: "Ubuntu 24.04 LTS" },
  cpu: { model: "Cortex-A76", cores: 4 },
  memory: { totalBytes: 8 * 1024 ** 3 },
  uptimeSeconds: 100,
  bootTime: 1_700_000_000_000,
  hardware: { model: "Raspberry Pi 5 Model B Rev 1.0", isRaspberryPi: true },
  capabilities: {
    procfs: { available: true },
    systemd: { available: true },
    journald: { available: true },
    docker: { available: false, reason: "socket-missing" },
    tailscale: { available: false, reason: "not-detected" },
    thermal: { available: true },
    raspberryPi: { available: true },
  },
  collectedAt: 1_700_000_100_000,
};

function handlers(overrides: Partial<OperationHandlers> = {}): OperationHandlers {
  return {
    "agent.ping": () => ({
      pong: true,
      agentVersion: "test",
      uptimeSeconds: 1,
      mode: "development",
    }),
    "system.info": () => sampleInfo,
    ...overrides,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  options: {
    handlers?: Partial<OperationHandlers>;
    clientKey?: Buffer;
    policy?: ConstructorParameters<typeof AgentServer>[0]["policy"];
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "otk-"));
  const socketPath = join(dir, "agent.sock");
  const server = new AgentServer({
    socketPath,
    agentKey,
    agentVersion: "0.1.0-test",
    handlers: handlers(options.handlers),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  await server.listen();
  cleanups.push(() => server.close());
  const client = new AgentClient({
    socketPath,
    agentKey: options.clientKey ?? agentKey,
    reconnectMinDelayMs: 20,
  });
  cleanups.push(() => client.stop());
  return { server, client, socketPath, dir };
}

describe("LineDecoder", () => {
  it("splits frames across arbitrary chunk boundaries", () => {
    const decoder = new LineDecoder();
    const payload = encodeFrame({ a: 1 }) + encodeFrame({ b: "x\ny" });
    const lines: string[] = [];
    for (const byte of Buffer.from(payload)) lines.push(...decoder.push(Buffer.from([byte])));
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ a: 1 }, { b: "x\ny" }]);
  });

  it("rejects oversized frames", () => {
    const decoder = new LineDecoder(16);
    expect(() => decoder.push(Buffer.from("x".repeat(17)))).toThrow(FrameTooLargeError);
  });
});

describe("agent protocol", () => {
  it("authenticates and executes typed operations", async () => {
    const { client, socketPath } = await setup();
    client.start();
    await client.waitUntilConnected();
    expect(client.state).toBe("connected");
    expect(client.agentVersion).toBe("0.1.0-test");
    const info = await client.call("system.info", {}, admin);
    expect(info.hostname).toBe("pi5");
    const pong = await client.call("agent.ping", {}, viewer);
    expect(pong.pong).toBe(true);
    if (process.platform !== "win32") expect(statSync(socketPath).mode & 0o777).toBe(0o660);
  });

  it("refuses clients that do not hold the agent key", async () => {
    const { client } = await setup({ clientKey: Buffer.alloc(32, 9) });
    client.start();
    await expect(client.waitUntilConnected(300)).rejects.toBeInstanceOf(AgentClientError);
    expect(client.state).not.toBe("connected");
  });

  it("closes connections that send requests before authenticating", async () => {
    const { socketPath } = await setup();
    const raw = connect(socketPath);
    cleanups.push(() => void raw.destroy());
    const received: string[] = [];
    raw.on("data", (chunk) => received.push(chunk.toString()));
    await new Promise((resolve) => raw.once("connect", resolve));
    raw.write(encodeFrame({ type: "request", id: 1, op: "system.info", params: {}, actor: admin }));
    await new Promise((resolve) => raw.once("close", resolve));
    expect(received.join("")).toContain('"type":"fatal"');
    expect(received.join("")).not.toContain("pi5");
  });

  it("derives authorization from the actor role and the contract", () => {
    const contract = {
      params: z.strictObject({}),
      result: z.unknown(),
      permission: "services:manage" as const,
      allowSystemActor: false,
      mutating: true,
      timeoutMs: 1000,
    };
    const operator: Actor = { kind: "user", userId: "u3", username: "op", role: "operator" };
    expect(isActorAuthorized(contract, admin)).toBe(true);
    expect(isActorAuthorized(contract, operator)).toBe(true);
    expect(isActorAuthorized(contract, viewer)).toBe(false);
    expect(isActorAuthorized(contract, { kind: "system", component: "scheduler" })).toBe(false);
    expect(
      isActorAuthorized(
        { ...contract, allowSystemActor: true },
        { kind: "system", component: "x" },
      ),
    ).toBe(true);
    expect(isActorAuthorized({ ...contract, permission: null }, viewer)).toBe(true);
  });

  it("rejects actors claiming an unknown role", async () => {
    const { socketPath } = await setup();
    const client = new AgentClient({ socketPath, agentKey });
    cleanups.push(() => client.stop());
    client.start();
    await client.waitUntilConnected();
    const forged = { kind: "user", userId: "u9", username: "x", role: "root" } as unknown as Actor;
    // An invalid envelope is a protocol violation: the agent drops the connection.
    await expect(client.call("system.info", {}, forged)).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
  });

  it("applies the operation policy", async () => {
    const { client } = await setup({
      policy: (op, _params, actor) =>
        op === "system.info" && actor.kind === "user" && actor.role === "viewer"
          ? { allowed: false, reason: "viewers blocked in this test" }
          : { allowed: true },
    });
    client.start();
    await client.waitUntilConnected();
    await expect(client.call("system.info", {}, viewer)).rejects.toMatchObject({
      code: "AGENT_OPERATION_DENIED",
      agentCode: "policy_denied",
    });
    await expect(client.call("system.info", {}, admin)).resolves.toBeDefined();
  });

  it("rejects invalid parameters without calling the handler", async () => {
    let called = false;
    const { client } = await setup({
      handlers: {
        "system.info": () => {
          called = true;
          return sampleInfo;
        },
      },
    });
    client.start();
    await client.waitUntilConnected();
    await expect(
      client.call("system.info", { unexpected: true } as never, admin),
    ).rejects.toMatchObject({
      agentCode: "invalid_params",
    });
    expect(called).toBe(false);
  });

  it("does not leak unexpected handler errors", async () => {
    const { client } = await setup({
      handlers: {
        "system.info": () => {
          throw new Error("secret internal detail");
        },
      },
    });
    client.start();
    await client.waitUntilConnected();
    const error = (await client
      .call("system.info", {}, admin)
      .catch((e: unknown) => e)) as AgentClientError;
    expect(error.code).toBe("AGENT_OPERATION_FAILED");
    expect(error.message).not.toContain("secret internal detail");
  });

  it("passes through safe OperationError messages", async () => {
    const { client } = await setup({
      handlers: {
        "system.info": () => {
          throw new OperationError("failed", "os-release unreadable");
        },
      },
    });
    client.start();
    await client.waitUntilConnected();
    await expect(client.call("system.info", {}, admin)).rejects.toThrow("os-release unreadable");
  });

  it("rejects results that violate the contract", async () => {
    const { client } = await setup({
      handlers: { "system.info": () => ({ hostname: 1 }) as unknown as SystemInfo },
    });
    client.start();
    await client.waitUntilConnected();
    await expect(client.call("system.info", {}, admin)).rejects.toMatchObject({
      code: "AGENT_OPERATION_FAILED",
    });
  });

  it("fails fast while disconnected and reconnects after an agent restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-"));
    const socketPath = join(dir, "agent.sock");
    const client = new AgentClient({
      socketPath,
      agentKey,
      reconnectMinDelayMs: 20,
      reconnectMaxDelayMs: 50,
    });
    cleanups.push(() => client.stop());
    client.start();
    await expect(client.call("agent.ping", {}, admin)).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });

    const first = new AgentServer({
      socketPath,
      agentKey,
      agentVersion: "1",
      handlers: handlers(),
    });
    await first.listen();
    await client.waitUntilConnected(2_000);
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.state).not.toBe("connected");

    const second = new AgentServer({
      socketPath,
      agentKey,
      agentVersion: "2",
      handlers: handlers(),
    });
    await second.listen();
    cleanups.push(() => second.close());
    await client.waitUntilConnected(2_000);
    expect(client.agentVersion).toBe("2");
    await expect(client.call("agent.ping", {}, admin)).resolves.toMatchObject({ pong: true });
  });

  it("refuses to start when another agent is live, and replaces stale sockets", async () => {
    const { socketPath } = await setup();
    const duplicate = new AgentServer({
      socketPath,
      agentKey,
      agentVersion: "dup",
      handlers: handlers(),
    });
    await expect(duplicate.listen()).rejects.toThrow(/already listening/);
  });

  it("never deletes a regular file at the socket path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-"));
    const socketPath = join(dir, "agent.sock");
    writeFileSync(socketPath, "important");
    const server = new AgentServer({
      socketPath,
      agentKey,
      agentVersion: "x",
      handlers: handlers(),
    });
    await expect(server.listen()).rejects.toThrow(/non-socket/);
  });
});
