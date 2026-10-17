import { installedVersion } from "@everyos/release";
import { lstatSync, chmodSync, chownSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AgentServer } from "@everyos/agent-protocol";
import { createLogger, serializeError } from "@everyos/logger";
import { deriveKey, loadKeyFile, SecretBox } from "@everyos/security";

import {
  createAptManager,
  createAptSimulator,
  createDiskManager,
  createDiskSimulator,
  createInternetProbe,
  findExecutable,
} from "@everyos/system";
import { selectBackends } from "./backends.ts";
import { ConfigError, loadAgentConfig, resolveGroupId } from "./config.ts";
import { createHandlers } from "./handlers.ts";
import { LinuxIdentities } from "./linux-identities.ts";
import { AccountWorkers } from "./account-workers.ts";
import { loadApiConfig } from "../../api/src/config.ts";
import { TerminalManager } from "./terminal.ts";
import { ManagedAppManager } from "./managed-apps.ts";
import { AppDataBackups } from "./app-data-backup.ts";
import { createPolicy } from "./policy.ts";
import { createContainerProtection, createUnitProtection } from "./protection.ts";

/**
 * Ensures a directory exists and that the API's group can traverse it
 * (root:everyos 0750). Shared or world-writable directories (e.g. /tmp) and
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

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const logger = createLogger({
    name: "everyos-agent",
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
  // start as root:everyos 0640 so the API can read but not modify it.
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

  // e2e runs use the labelled apt simulator; development never changes host packages.
  const apt =
    config.mode === "development" && config.simulate ? createAptSimulator() : createAptManager();
  let workers: AccountWorkers | undefined;
  const identities =
    config.mode === "production"
      ? new LinuxIdentities({
          path: "/var/lib/everyos-agent/identities/bindings.json",
          onChange: (userId) => {
            terminal?.closeForUser(userId);
            workers?.closeUser(userId);
          },
        })
      : undefined;
  if (identities) {
    const apiFile = "/etc/everyos/config.yaml";
    const info = lstatSync(apiFile);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new ConfigError("Unsafe API file roots configuration");
    const apiConfig = loadApiConfig({ EVERYOS_ENV: "production", EVERYOS_CONFIG: apiFile });
    workers = new AccountWorkers({
      config,
      identities,
      files: apiConfig.files,
      version: installedVersion(),
    });
  }
  const terminal = new TerminalManager({
    config: config.terminal,
    ...(identities ? { identities } : {}),
    logger,
    lang: process.env.LANG?.includes("UTF-8") ? process.env.LANG : "C.UTF-8",
  });
  const apps = new ManagedAppManager({
    docker,
    secrets: new SecretBox(deriveKey(agentKey, "otuken/agent-apps/v1")),
    root: config.appsRoot,
    isProtected: isProtectedContainer,
  });
  const appData = new AppDataBackups({ apps, logger });
  // Development lists the host's disks where lsblk exists but never mounts them (policy).
  const disks =
    config.mode === "development" && (config.simulate || !(await findExecutable("lsblk")))
      ? createDiskSimulator({ mountRoot: config.disksRoot })
      : createDiskManager({ mountRoot: config.disksRoot });
  const handlers = createHandlers({
    mode: config.mode,
    version: installedVersion(),
    startedAt: Date.now(),
    services,
    logs,
    isProtected,
    internet: createInternetProbe(config.internetCheckTargets),
    docker,
    isProtectedContainer,
    terminal,
    apt,
    ...(identities ? { identities } : {}),
    ...(config.tailscaleSocket ? { tailscaleSockets: [config.tailscaleSocket] } : {}),
    apps,
    appData,
    disks,
  });
  const server = new AgentServer({
    // Terminals and log tails hold streams open; the API uses one connection.
    maxStreamsPerConnection: 32,
    socketPath: config.socketPath,
    agentKey,
    agentVersion: installedVersion(),
    handlers: workers ? workers.wrap(handlers) : handlers,
    policy: createPolicy({
      mode: config.mode,
      isProtected,
      servicesSource: services.source,
      dockerSource: docker.source,
      aptSource: apt.source,
      disksSource: disks.source,
    }),
    logger,
    socketMode: socketGroupId === null ? 0o600 : 0o660,
    socketGroupId: isRoot ? socketGroupId : null,
  });
  await server.listen();
  logger.info("EveryOS agent started", {
    version: installedVersion(),
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
    terminal.closeAll();
    workers?.closeAll();
    void appData.closeAll();
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
  const logger = createLogger({ name: "everyos-agent" });
  logger.fatal("Agent failed to start", { error });
  process.exitCode = 1;
});
