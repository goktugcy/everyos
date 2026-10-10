import { chmodSync, chownSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AgentServer } from "@otuken/agent-protocol";
import { createLogger, serializeError } from "@otuken/logger";
import { loadKeyFile } from "@otuken/security";
import { OTUKEN_VERSION } from "@otuken/shared";
import { ConfigError, loadAgentConfig, resolveGroupId } from "./config.ts";
import { createHandlers } from "./handlers.ts";
import { createPolicy } from "./policy.ts";

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

  const server = new AgentServer({
    socketPath: config.socketPath,
    agentKey,
    agentVersion: OTUKEN_VERSION,
    handlers: createHandlers({ mode: config.mode, version: OTUKEN_VERSION, startedAt: Date.now() }),
    policy: createPolicy(),
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
