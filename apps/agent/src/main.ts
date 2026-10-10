import { chmodSync, chownSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AgentServer } from "@otuken/agent-protocol";
import { createLogger, serializeError } from "@otuken/logger";
import { loadKeyFile } from "@otuken/security";
import { OTUKEN_VERSION } from "@otuken/shared";
import {
  createDockerClient,
  createDockerSimulator,
  createInternetProbe,
  createJournalSource,
  createSimulator,
  createSystemdManager,
  detectCapabilities,
  pathKind,
  REAL_HOST,
  type DockerApi,
  type LogSource,
  type ServiceManager,
} from "@otuken/system";
import { ConfigError, loadAgentConfig, resolveGroupId, type AgentConfig } from "./config.ts";
import { createHandlers } from "./handlers.ts";
import { ManagedAppManager } from "./managed-apps.ts";
import { createPolicy } from "./policy.ts";
import { createContainerProtection, createUnitProtection } from "./protection.ts";

/**
 * Ensures a directory exists and that the API's group can traverse it
 * (root:otuken 0750). Shared or world-writable directories (e.g. /tmp) and
 * directories owned by other users are never modified.
 */
function prepareGroupDirectory(path: string, groupId: number | null): void {
  mkdirSync(path, { recursive: true, mode: 0o750 });
  if (groupId === null) return;
  const info = statSync(path);
  if (info.uid !== 0 || (info.mode & 0o002) !== 0) return;
  if (info.gid !== groupId) chownSync(path, 0, groupId);
  if ((info.mode & 0o777) !== 0o750) chmodSync(path, 0o750);
}

/**
 * Picks the real systemd/journald backends, or the simulator in development
 * when they are missing (macOS) or explicitly requested. Production never
 * uses simulated data: missing tools surface as "unsupported" errors.
 */
async function selectBackends(
  config: AgentConfig,
  isProtectedContainer: (name: string) => boolean,
): Promise<{ services: ServiceManager; logs: LogSource; docker: DockerApi }> {
  const capabilities = await detectCapabilities(REAL_HOST, null);
  const simulator = config.mode === "development" ? createSimulator() : null;
  const services =
    simulator && (config.simulate || !capabilities.systemd.available)
      ? simulator.services
      : createSystemdManager();
  const logs =
    simulator && (config.simulate || !capabilities.journald.available)
      ? simulator.logs
      : createJournalSource();
  const dockerSocketPresent = config.dockerSocket
    ? (await pathKind(config.dockerSocket)) !== "missing"
    : capabilities.docker.available || capabilities.docker.reason === "permission-denied";
  const docker =
    config.mode === "development" && (config.simulate || !dockerSocketPresent)
      ? createDockerSimulator({ isProtected: isProtectedContainer })
      : createDockerClient({
          ...(config.dockerSocket ? { socketPaths: [config.dockerSocket] } : {}),
          isProtected: isProtectedContainer,
        });
  return { services, logs, docker };
}

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const logger = createLogger({
    name: "otuken-agent",
    level: config.logLevel,
    format: config.logFormat,
  });
  const isRoot = process.getuid?.() === 0;

  if (config.mode === "development" && isRoot) {
    // Development mode must never hold real privileges on the developer's machine.
    throw new ConfigError("Refusing to run the agent as root in development mode");
  }
  if (config.mode === "production" && !isRoot) {
    logger.warn("Agent is not running as root; privileged operations will fail");
  }

  const socketGroupId = config.socketGroup === null ? null : resolveGroupId(config.socketGroup);
  const groupId = isRoot ? socketGroupId : null;
  prepareGroupDirectory(dirname(config.socketPath), groupId);

  // The agent (root in production) owns the shared key. It is created on first
  // start as root:otuken 0640 so the API can read but not modify it.
  prepareGroupDirectory(dirname(config.agentKeyFile), groupId);
  const agentKey = loadKeyFile(config.agentKeyFile, {
    create: true,
    enforcePermissions: true,
    mode: socketGroupId === null ? 0o600 : 0o640,
  });
  if (socketGroupId !== null && isRoot) chownSync(config.agentKeyFile, 0, socketGroupId);

  const isProtected = createUnitProtection(config.protectedUnits);
  const isProtectedContainer = createContainerProtection(config.protectedContainers);
  const { services, logs, docker } = await selectBackends(config, isProtectedContainer);
  if (
    services.source === "simulated" ||
    logs.source === "simulated" ||
    docker.source === "simulated"
  ) {
    logger.warn("Using simulated host data (development only)", {
      services: services.source,
      logs: logs.source,
      docker: docker.source,
    });
  }

  const server = new AgentServer({
    socketPath: config.socketPath,
    agentKey,
    agentVersion: OTUKEN_VERSION,
    handlers: createHandlers({
      mode: config.mode,
      version: OTUKEN_VERSION,
      startedAt: Date.now(),
      services,
      logs,
      isProtected,
      internet: createInternetProbe(config.internetCheckTargets),
      docker,
      isProtectedContainer,
      apps: new ManagedAppManager({
        docker,
        root:
          config.mode === "production"
            ? "/var/lib/otuken/apps"
            : `${process.env.OTUKEN_DEV_ROOT ?? dirname(config.socketPath)}/agent-apps`,
        isProtected: isProtectedContainer,
      }),
    }),
    policy: createPolicy({
      mode: config.mode,
      isProtected,
      servicesSource: services.source,
      dockerSource: docker.source,
    }),
    logger,
    socketMode: socketGroupId === null ? 0o600 : 0o660,
    socketGroupId: isRoot ? socketGroupId : null,
  });
  await server.listen();
  logger.info("Otuken agent started", {
    version: OTUKEN_VERSION,
    mode: config.mode,
    pid: process.pid,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    forceExit.unref();
    server
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error("Error during shutdown", { error });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.fatal("Uncaught exception", { error });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason: serializeError(reason) });
  });
}

main().catch((error: unknown) => {
  const logger = createLogger({ name: "otuken-agent" });
  logger.fatal("Agent failed to start", { error });
  process.exitCode = 1;
});
