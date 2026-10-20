import { installedVersion } from "@everyos/release";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { serve } from "@hono/node-server";
import { migrate, openDatabase, EVERYOS_MIGRATIONS } from "@everyos/database";
import { createLogger, serializeError } from "@everyos/logger";
import { loadKeyFile } from "@everyos/security";

import { LazyAgentGateway } from "./agent-gateway.ts";
import { createApp } from "./app.ts";
import { isExposedBinding, loadApiConfig } from "./config.ts";
import { createServices } from "./services.ts";
import { attachTerminalGateway } from "./modules/terminal/gateway.ts";
import { applyPendingRestore } from "./modules/backups/snapshot.ts";
import { createLanListener } from "./modules/security/lan-listener.ts";
import type { Server } from "node:http";

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
/** Exit status asking the service manager to start EveryOS again (EX_TEMPFAIL). */
const RESTART_EXIT_CODE = 75;

async function main(): Promise<void> {
  const config = loadApiConfig();
  // New files (database, backups, secrets) are never world-readable.
  process.umask(0o027);
  const logger = createLogger({
    name: "everyos",
    level: config.logging.level,
    format: config.logging.format,
  });
  logger.info("Starting EveryOS API", {
    version: installedVersion(),
    mode: config.mode,
    node: process.version,
  });

  if (process.getuid?.() === 0) {
    logger.warn(
      "The API is running as root. It is designed to run as the unprivileged 'everyos' user.",
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
  // A database restore staged from a backup is applied before the database is opened, and
  // before the server secret is read: a backup from another machine brings its own.
  const restored = await applyPendingRestore({
    dataDir: config.paths.dataDir,
    databaseFile: config.paths.databaseFile,
    backupDir: config.paths.backupDir,
    secretKeyFile: config.paths.secretKeyFile,
    keysDir: join(config.paths.dataDir, "keys"),
    logger,
  });
  const masterKey = loadKeyFile(config.paths.secretKeyFile, {
    create: true,
    enforcePermissions: true,
  });
  const db = openDatabase(config.paths.databaseFile);
  const migration = await migrate(db, EVERYOS_MIGRATIONS, {
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

  let shutdown: (signal: string, code?: number) => void = () => undefined;
  // Development and browser tests can use an in-memory stand-in for Google (never in production).
  const fakeGoogle =
    config.mode === "development" && process.env.EVERYOS_DEV_FAKE_GOOGLE === "1"
      ? await (await import("./modules/drive/fake-google.ts")).startFakeGoogle()
      : null;
  if (fakeGoogle) logger.warn("Using the fake Google Drive", { origin: fakeGoogle.endpoints.api });
  const services = createServices({
    config,
    logger,
    db,
    masterKey,
    agent,
    ...(fakeGoogle ? { google: fakeGoogle.endpoints } : {}),
    requestRestart: () => shutdown("restore", RESTART_EXIT_CODE),
  });
  services.setup.initialize();
  if (restored)
    services.audit.record({
      action: "backups.restore.applied",
      outcome: "success",
      actor: null,
      target: restored.backupId,
      details: { requestedBy: restored.requestedBy, previous: restored.previous },
    });
  await services.backups.start();
  if (config.mode === "development") await services.files.ensureRoots();
  const app = createApp(services);
  services.metrics.start();
  services.hostMonitor.start();
  services.disks.start();
  services.desktopApps.start();
  if (config.mode === "production") services.releaseMonitor.start();
  const startTasks = () => {
    if (config.mode === "production" && existsSync("/run/everyos-update-maintenance")) return;
    clearInterval(taskStartTimer);
    services.tasks.start();
  };
  const taskStartTimer = setInterval(startTasks, 1000);
  taskStartTimer.unref();
  startTasks();

  const runMaintenance = () => {
    try {
      const sessions = services.sessions.purgeExpired();
      const audit = services.audit.prune();
      const notifications = services.notifications.prune();
      if (sessions + audit + notifications > 0)
        logger.debug("Maintenance completed", {
          purgedSessions: sessions,
          prunedAudit: audit,
          prunedNotifications: notifications,
        });
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
      logger.info("EveryOS API listening", {
        url: `${tls ? "https" : "http"}://${info.family === "IPv6" ? `[${info.address}]` : info.address}:${info.port}`,
      });
    },
  );
  const detachTerminals = attachTerminalGateway(server as Server, services);
  server.on("error", (error) => {
    logger.fatal("HTTP server error", { error });
    process.exit(1);
  });
  // Local-network HTTPS with EveryOS's own certificate authority, when an administrator turns it on.
  const lan = createLanListener({
    fetch: app.fetch,
    hostname: config.server.host,
    attach: (secure) => attachTerminalGateway(secure, services),
    logger,
  });
  services.https.attach(lan);
  await services.https.start().catch((error: unknown) => {
    logger.error("Local-network HTTPS could not start", { error });
  });

  let shuttingDown = false;
  shutdown = (signal: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    clearInterval(maintenanceTimer);
    clearInterval(taskStartTimer);
    services.metrics.stop();
    services.docker.stop();
    services.widgetData.stop();
    services.hostMonitor.stop();
    services.disks.stop();
    services.desktopApps.stop();
    services.transfers.stop();
    services.releaseMonitor.stop();
    services.terminals.stop();
    services.updates.stop();
    services.tasks.stop();
    services.backups.stop();
    services.https.stop();
    void lan.close();
    detachTerminals();
    services.catalogs.stop();
    services.apps.stop();
    services.aiAgents.stop();
    services.localModels.stop();
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    server.close(() => {
      agent.stop();
      db.close();
      process.exit(code);
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
  createLogger({ name: "everyos" }).fatal("EveryOS API failed to start", { error });
  process.exitCode = 1;
});
