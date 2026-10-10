import { mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { serve } from "@hono/node-server";
import { migrate, openDatabase, OTUKEN_MIGRATIONS } from "@otuken/database";
import { createLogger, serializeError } from "@otuken/logger";
import { loadKeyFile } from "@otuken/security";
import { OTUKEN_VERSION } from "@otuken/shared";
import { LazyAgentGateway } from "./agent-gateway.ts";
import { createApp } from "./app.ts";
import { isExposedBinding, loadApiConfig } from "./config.ts";
import { createServices } from "./services.ts";

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

async function main(): Promise<void> {
  const config = loadApiConfig();
  // New files (database, backups, secrets) are never world-readable.
  process.umask(0o027);
  const logger = createLogger({
    name: "otuken",
    level: config.logging.level,
    format: config.logging.format,
  });
  logger.info("Starting Otuken API", {
    version: OTUKEN_VERSION,
    mode: config.mode,
    node: process.version,
  });

  if (process.getuid?.() === 0) {
    logger.warn(
      "The API is running as root. It is designed to run as the unprivileged 'otuken' user.",
    );
  }
  if (isExposedBinding(config.server.host) && !config.server.tls) {
    logger.warn(
      "The API listens on a non-loopback address without TLS. Put it behind HTTPS (reverse proxy or Tailscale) before exposing it.",
      {
        host: config.server.host,
      },
    );
  }

  mkdirSync(config.paths.dataDir, { recursive: true, mode: 0o750 });
  const masterKey = loadKeyFile(config.paths.secretKeyFile, {
    create: true,
    enforcePermissions: true,
  });

  const db = openDatabase(config.paths.databaseFile);
  const migration = await migrate(db, OTUKEN_MIGRATIONS, {
    backupDir: config.paths.backupDir,
    logger,
  });
  if (migration.applied.length > 0)
    logger.info("Database migrated", { from: migration.from, to: migration.to });

  const agent = new LazyAgentGateway({
    socketPath: config.paths.agentSocket,
    keyFile: config.paths.agentKeyFile,
    logger,
  });
  agent.start();

  const services = createServices({ config, logger, db, masterKey, agent });
  services.setup.initialize();
  const app = createApp(services);
  services.metrics.start();

  const runMaintenance = () => {
    try {
      const sessions = services.sessions.purgeExpired();
      const audit = services.audit.prune();
      if (sessions + audit > 0)
        logger.debug("Maintenance completed", { purgedSessions: sessions, prunedAudit: audit });
    } catch (error) {
      logger.error("Maintenance failed", { error });
    }
  };
  runMaintenance();
  const maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  const tls = config.server.tls;
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.server.host,
      port: config.server.port,
      ...(tls
        ? {
            createServer: createHttpsServer,
            serverOptions: { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) },
          }
        : {}),
    },
    (info) => {
      logger.info("Otuken API listening", {
        url: `${tls ? "https" : "http"}://${info.family === "IPv6" ? `[${info.address}]` : info.address}:${info.port}`,
      });
    },
  );
  server.on("error", (error) => {
    logger.fatal("HTTP server error", { error });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    clearInterval(maintenanceTimer);
    services.metrics.stop();
    services.docker.stop();
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    server.close(() => {
      agent.stop();
      db.close();
      process.exit(0);
    });
    // Event streams never finish on their own; give normal requests a moment first.
    const closeStreams = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, 2_000);
    closeStreams.unref();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason: serializeError(reason) });
  });
}

main().catch((error: unknown) => {
  createLogger({ name: "otuken" }).fatal("Otuken API failed to start", { error });
  process.exitCode = 1;
});
