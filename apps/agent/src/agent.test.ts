import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@otuken/agent-protocol";
import { silentLogger } from "@otuken/logger";
import type { SystemInfo } from "@otuken/shared";
import {
  createDockerClient,
  createDockerSimulator,
  createSimulator,
  ServiceError,
  type DockerApi,
  type ServiceManager,
} from "@otuken/system";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  DEFAULT_INTERNET_CHECK_TARGETS,
  loadAgentConfig,
  resolveGroupId,
} from "./config.ts";
import { createHandlers, type HandlerDependencies } from "./handlers.ts";
import { createPolicy } from "./policy.ts";
import { createContainerProtection, createUnitProtection } from "./protection.ts";

const actorContext = {
  actor: { kind: "system", component: "test" } as const,
  signal: new AbortController().signal,
  logger: silentLogger,
};

function contextFor(actor: Actor, signal = new AbortController().signal) {
  return { actor, signal, logger: silentLogger };
}

const admin: Actor = { kind: "user", userId: "u1", username: "admin", role: "admin" };
const operator: Actor = { kind: "user", userId: "u2", username: "op", role: "operator" };

function deps(overrides: Partial<HandlerDependencies> = {}): HandlerDependencies {
  const simulator = createSimulator(() => 1_760_000_000_000);
  return {
    mode: "development",
    version: "1.2.3",
    startedAt: 0,
    services: simulator.services,
    logs: simulator.logs,
    isProtected: createUnitProtection(),
    internet: () => Promise.resolve({ state: "disabled", checkedAt: null, latencyMs: null }),
    docker: createDockerSimulator({ now: () => 1_760_000_000_000 }),
    isProtectedContainer: createContainerProtection(["portainer", "traefik*"]),
    ...overrides,
  };
}

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

  it("reads protection and connectivity settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-agent-"));
    const path = join(dir, "agent.yaml");
    writeFileSync(
      path,
      "protectedUnits: [nginx.service, 'docker*.service']\ninternetCheckTargets: []\n",
    );
    expect(loadAgentConfig({ OTUKEN_AGENT_CONFIG: path })).toMatchObject({
      protectedUnits: ["nginx.service", "docker*.service"],
      internetCheckTargets: [],
    });
    expect(loadAgentConfig({}).internetCheckTargets).toEqual(DEFAULT_INTERNET_CHECK_TARGETS);
    writeFileSync(path, "protectedUnits: ['x; rm -rf /']\n");
    expect(() => loadAgentConfig({ OTUKEN_AGENT_CONFIG: path })).toThrow(/Invalid agent config/);
  });

  it("only simulates host data in development mode", () => {
    expect(() => loadAgentConfig({ OTUKEN_AGENT_SIMULATE: "1" })).toThrow(
      /only allowed in development/,
    );
    expect(
      loadAgentConfig({
        OTUKEN_ENV: "development",
        OTUKEN_DEV_ROOT: "/tmp/otk",
        OTUKEN_AGENT_SIMULATE: "1",
      }).simulate,
    ).toBe(true);
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
    const handlers = createHandlers(deps({ now: () => 5_000 }));
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
    const handlers = createHandlers(
      deps({
        mode: "production",
        now: () => clock,
        collect: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return info;
        },
      }),
    );
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

describe("unit protection and policy", () => {
  const isProtected = createUnitProtection(["nginx.service", "docker*.service"]);

  it("protects remote access, the platform itself and configured units", () => {
    for (const unit of [
      "ssh.service",
      "otuken-agent.service",
      "tailscaled.service",
      "systemd-journald.service",
      "getty@tty1.service",
      "nginx.service",
      "docker-compose@x.service",
    ]) {
      expect(isProtected(unit), unit).toBe(true);
    }
    expect(isProtected("jellyfin.service")).toBe(false);
    // Glob metacharacters other than * are literal.
    expect(createUnitProtection(["a.service"])("aXservice")).toBe(false);
  });

  it("blocks disruptive actions on protected units for every role", () => {
    const policy = createPolicy({
      mode: "production",
      isProtected,
      servicesSource: "host",
      dockerSource: "host",
    });
    expect(
      policy("services.control", { unit: "ssh.service", action: "stop" }, admin),
    ).toMatchObject({ allowed: false });
    expect(
      policy("services.control", { unit: "ssh.service", action: "restart" }, admin).allowed,
    ).toBe(false);
    expect(
      policy("services.control", { unit: "ssh.service", action: "disable" }, admin).allowed,
    ).toBe(false);
    expect(
      policy("services.control", { unit: "ssh.service", action: "start" }, admin).allowed,
    ).toBe(true);
    // Boot configuration stays untouched too (Ubuntu's ssh.service is socket-activated).
    expect(
      policy("services.control", { unit: "ssh.service", action: "enable" }, admin).allowed,
    ).toBe(false);
    expect(
      policy("services.control", { unit: "jellyfin.service", action: "stop" }, operator).allowed,
    ).toBe(true);
    expect(policy("services.list", {}, operator).allowed).toBe(true);
  });

  it("never lets a development agent change host services", () => {
    const onHost = createPolicy({
      mode: "development",
      isProtected,
      servicesSource: "host",
      dockerSource: "host",
    });
    expect(
      onHost("services.control", { unit: "jellyfin.service", action: "start" }, admin),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("development") as string,
    });
    const simulated = createPolicy({
      mode: "development",
      isProtected,
      servicesSource: "simulated",
      dockerSource: "simulated",
    });
    expect(
      simulated("services.control", { unit: "jellyfin.service", action: "start" }, admin).allowed,
    ).toBe(true);
  });
});

describe("host operation handlers", () => {
  it("hides process command lines from actors who cannot manage the system", async () => {
    const handlers = createHandlers(deps());
    const asOperator = await handlers["processes.list"](
      { sort: "memory", limit: 5 },
      contextFor(operator),
    );
    expect(asOperator.processes.length).toBeGreaterThan(0);
    for (const process of asOperator.processes) expect(process.command).toBe(process.name);
    const asAdmin = await handlers["processes.list"](
      { sort: "memory", limit: 5 },
      contextFor(admin),
    );
    expect(asAdmin.processes.length).toBeLessThanOrEqual(5);
  });

  it("controls simulated services and reports missing units", async () => {
    const handlers = createHandlers(deps());
    await expect(
      handlers["services.control"](
        { unit: "jellyfin.service", action: "start" },
        contextFor(admin),
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      handlers["services.get"]({ unit: "jellyfin.service" }, contextFor(admin)),
    ).resolves.toMatchObject({
      active: "active",
      protected: false,
      source: "simulated",
    });
    await expect(
      handlers["services.get"]({ unit: "nope.service" }, contextFor(admin)),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("reports hosts without systemd as unsupported", async () => {
    const unavailable: ServiceManager = {
      source: "host",
      list: () => Promise.reject(new ServiceError("unavailable", "no systemctl")),
      get: () => Promise.reject(new ServiceError("unavailable", "no systemctl")),
      control: () => Promise.reject(new ServiceError("unavailable", "no systemctl")),
    };
    const handlers = createHandlers(deps({ services: unavailable }));
    await expect(handlers["services.list"]({}, contextFor(admin))).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("limits concurrent live log streams", async () => {
    const handlers = createHandlers(deps({ maxLogFollows: 1 }));
    const first = new AbortController();
    const stream = handlers["logs.follow"]({}, contextFor(admin, first.signal))[
      Symbol.asyncIterator
    ]();
    const pending = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = handlers["logs.follow"]({}, contextFor(admin))[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toMatchObject({ code: "busy" });
    first.abort();
    await pending;
    await stream.return?.();
  });
});

describe("docker handlers and policy", () => {
  const viewer: Actor = { kind: "user", userId: "u3", username: "viewer", role: "viewer" };

  it("never changes Docker on the host from a development agent", () => {
    const policy = createPolicy({
      mode: "development",
      isProtected: () => false,
      servicesSource: "simulated",
      dockerSource: "host",
    });
    for (const op of ["docker.containers.control", "docker.volumes.remove", "docker.compose.run"]) {
      expect(policy(op, {}, admin)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("DEVELOPMENT_MODE") as string,
      });
    }
    expect(policy("docker.containers.list", {}, admin).allowed).toBe(true);
    const simulated = createPolicy({
      mode: "development",
      isProtected: () => false,
      servicesSource: "simulated",
      dockerSource: "simulated",
    });
    expect(simulated("docker.containers.control", {}, admin).allowed).toBe(true);
  });

  it("only starts protected containers", async () => {
    const handlers = createHandlers(deps());
    const { containers } = await handlers["docker.containers.list"]({}, contextFor(admin));
    const portainer = containers.find((c) => c.name === "portainer")!;
    await expect(
      handlers["docker.containers.control"](
        { id: portainer.id, action: "stop" },
        contextFor(admin),
      ),
    ).rejects.toMatchObject({
      code: "policy_denied",
      message: expect.stringContaining("PROTECTED_CONTAINER") as string,
    });
    await expect(
      handlers["docker.containers.control"](
        { id: portainer.id, action: "start" },
        contextFor(admin),
      ),
    ).resolves.toEqual({ accepted: true });
    const jellyfin = containers.find((c) => c.name === "jellyfin")!;
    await expect(
      handlers["docker.containers.control"](
        { id: jellyfin.id, action: "restart" },
        contextFor(operator),
      ),
    ).resolves.toEqual({ accepted: true });
  });

  it("hides container commands from actors who cannot manage Docker", async () => {
    const handlers = createHandlers(deps());
    const { containers } = await handlers["docker.containers.list"]({}, contextFor(admin));
    const id = containers[0]!.id;
    expect(
      (await handlers["docker.containers.get"]({ id }, contextFor(viewer))).command,
    ).toBeNull();
    expect(
      (await handlers["docker.containers.get"]({ id }, contextFor(admin))).command,
    ).not.toBeNull();
  });

  it("cannot bypass container protection with Compose actions", async () => {
    const docker = createDockerSimulator();
    const runCompose = vi.fn((...args: Parameters<DockerApi["runCompose"]>) =>
      docker.runCompose(...args),
    );
    const handlers = createHandlers(
      deps({
        docker: { ...docker, runCompose },
        isProtectedContainer: (name) => name === "jellyfin",
      }),
    );
    const params = {
      project: "media",
      workingDir: "/srv/media",
      configFiles: ["/srv/media/compose.yaml"],
    };
    for (const actor of [admin, operator]) {
      for (const action of ["up", "stop", "restart", "update", "down"] as const) {
        await expect(
          handlers["docker.compose.run"]({ ...params, action }, contextFor(actor)),
        ).rejects.toMatchObject({
          code: "policy_denied",
          message: expect.stringContaining("PROTECTED_CONTAINER") as string,
        });
      }
    }
    expect(runCompose).not.toHaveBeenCalled();
    await expect(
      handlers["docker.compose.run"]({ ...params, action: "start" }, contextFor(admin)),
    ).resolves.toMatchObject({ ok: true });
    expect(runCompose).toHaveBeenCalledOnce();
  });

  it("reports hosts without Docker as unsupported", async () => {
    const handlers = createHandlers(
      deps({ docker: createDockerClient({ socketPaths: ["/nonexistent/docker.sock"] }) }),
    );
    await expect(handlers["docker.containers.list"]({}, contextFor(admin))).rejects.toMatchObject({
      code: "unsupported",
    });
    expect((await handlers["docker.status"]({}, contextFor(admin))).status.available).toBe(false);
  });

  it("maps conflicts (resources in use) to the conflict code", async () => {
    const handlers = createHandlers(deps());
    await expect(
      handlers["docker.volumes.remove"]({ name: "cloud_db" }, contextFor(admin)),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
