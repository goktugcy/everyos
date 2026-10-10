import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemInfo } from "@otuken/shared";
import { describe, expect, it } from "vitest";
import { ConfigError, loadAgentConfig, resolveGroupId } from "./config.ts";
import { createHandlers } from "./handlers.ts";

const actorContext = {
  actor: { kind: "system", component: "test" } as const,
  signal: new AbortController().signal,
  logger: { child: () => undefined } as never,
};

describe("agent config", () => {
  it("uses hardened production defaults", () => {
    const config = loadAgentConfig({ OTUKEN_AGENT_CONFIG: undefined });
    expect(config).toMatchObject({
      mode: "production",
      socketPath: "/run/otuken/agent.sock",
      agentKeyFile: "/etc/otuken/agent.key",
      socketGroup: "otuken",
      logFormat: "json",
    });
  });

  it("requires an explicit dev root in development mode", () => {
    expect(() => loadAgentConfig({ OTUKEN_ENV: "development" })).toThrow(ConfigError);
    const config = loadAgentConfig({ OTUKEN_ENV: "development", OTUKEN_DEV_ROOT: "/tmp/otk" });
    expect(config).toMatchObject({
      socketPath: "/tmp/otk/run/agent.sock",
      socketGroup: null,
      logFormat: "pretty",
    });
  });

  it("reads and validates an explicit config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-agent-"));
    const path = join(dir, "agent.yaml");
    writeFileSync(path, "socketPath: /run/custom.sock\nsocketGroup: 1001\nlogLevel: warn\n");
    expect(loadAgentConfig({ OTUKEN_AGENT_CONFIG: path })).toMatchObject({
      socketPath: "/run/custom.sock",
      socketGroup: 1001,
      logLevel: "warn",
    });
    writeFileSync(path, "socketPath: /x\nrunAnything: true\n");
    expect(() => loadAgentConfig({ OTUKEN_AGENT_CONFIG: path })).toThrow(/Invalid agent config/);
  });

  it("rejects invalid log levels", () => {
    expect(() => loadAgentConfig({ OTUKEN_LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("resolves group names from a group file", () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-agent-"));
    const groupFile = join(dir, "group");
    writeFileSync(groupFile, "root:x:0:\notuken:x:998:otuken\n");
    expect(resolveGroupId("otuken", groupFile)).toBe(998);
    expect(resolveGroupId("42", groupFile)).toBe(42);
    expect(() => resolveGroupId("missing", groupFile)).toThrow(/does not exist/);
  });
});

describe("agent handlers", () => {
  const info = { hostname: "h" } as SystemInfo;

  it("answers ping with version, uptime and mode", () => {
    const handlers = createHandlers({
      mode: "development",
      version: "1.2.3",
      startedAt: 0,
      now: () => 5_000,
    });
    expect(handlers["agent.ping"]({}, actorContext)).toEqual({
      pong: true,
      agentVersion: "1.2.3",
      uptimeSeconds: 5,
      mode: "development",
    });
  });

  it("caches and coalesces system info collection", async () => {
    let calls = 0;
    let clock = 0;
    const handlers = createHandlers({
      mode: "production",
      version: "x",
      startedAt: 0,
      now: () => clock,
      collect: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return info;
      },
    });
    await Promise.all([
      handlers["system.info"]({}, actorContext),
      handlers["system.info"]({}, actorContext),
    ]);
    expect(calls).toBe(1);
    clock = 5_000;
    await handlers["system.info"]({}, actorContext);
    expect(calls).toBe(1);
    clock = 20_000;
    await handlers["system.info"]({}, actorContext);
    expect(calls).toBe(2);
  });
});
