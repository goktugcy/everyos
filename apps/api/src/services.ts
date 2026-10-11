import { createHash } from "node:crypto";
import type { AgentClient } from "@everyos/agent-protocol";
import {
  createDummyVerifier,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
  type PasswordVerification,
  type ScryptParams,
} from "@everyos/auth";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import { deriveKey, SecretBox } from "@everyos/security";
import { createProxyMatcher, type ApiConfig } from "./config.ts";
import { AuditLog } from "./modules/audit/audit-log.ts";
import { LoginChallengeStore } from "./modules/auth/login-challenges.ts";
import { DockerHub } from "./modules/docker/docker-hub.ts";
import { IntegrationService } from "./modules/integrations/integration-service.ts";
import { DataHub } from "./modules/widgets/data-hub.ts";
import { systemProviders } from "./modules/widgets/providers.ts";
import { DockerProjectRepository } from "./modules/docker/project-repository.ts";
import { MetricsHub } from "./modules/metrics/metrics-hub.ts";
import { PreferenceRepository } from "./modules/preferences/preference-repository.ts";
import { FailureLimiter } from "./modules/auth/rate-limiter.ts";
import { SessionService } from "./modules/auth/session-service.ts";
import { SetupService } from "./modules/setup/setup-service.ts";
import { UserRepository } from "./modules/users/user-repository.ts";
import { WallpaperService } from "./modules/wallpapers/wallpaper-service.ts";
import { CatalogService } from "./modules/catalogs/catalog-service.ts";
import { AppService, type FinishedJob } from "./modules/apps/app-service.ts";
import { HostMonitor } from "./modules/notifications/host-monitor.ts";
import { FileService } from "./modules/files/file-service.ts";
import { TerminalService } from "./modules/terminal/terminal-service.ts";
import { UpdateService } from "./modules/updates/update-service.ts";
import { TaskService } from "./modules/tasks/task-service.ts";
import { taskExecutors } from "./modules/tasks/executors.ts";
import { BackupService } from "./modules/backups/backup-service.ts";
import { logProvider, NotificationService } from "./modules/notifications/notification-service.ts";

/** The subset of the agent client the HTTP layer depends on. */
export type AgentGateway = Pick<AgentClient, "state" | "call" | "stream">;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<PasswordVerification>;
  /** Equalizes timing when the user does not exist. */
  dummyVerify(): Promise<void>;
}

export interface Limiters {
  loginIp: FailureLimiter;
  loginUser: FailureLimiter;
  setupIp: FailureLimiter;
  sensitiveUser: FailureLimiter;
}

export interface Services {
  config: ApiConfig;
  logger: Logger;
  db: Database;
  users: UserRepository;
  preferences: PreferenceRepository;
  wallpapers: WallpaperService;
  sessions: SessionService;
  audit: AuditLog;
  setup: SetupService;
  secrets: SecretBox;
  agent: AgentGateway;
  metrics: MetricsHub;
  docker: DockerHub;
  dockerProjects: DockerProjectRepository;
  catalogs: CatalogService;
  apps: AppService;
  integrations: IntegrationService;
  /** Shared, reference-counted widget data topics. */
  widgetData: DataHub;
  notifications: NotificationService;
  files: FileService;
  terminals: TerminalService;
  updates: UpdateService;
  tasks: TaskService;
  backups: BackupService;
  /** Background host checks that raise and resolve notification conditions. */
  hostMonitor: HostMonitor;
  /** How often open event streams re-check access and send a keep-alive. */
  eventStreamHeartbeatMs: number;
  limiters: Limiters;
  challenges: LoginChallengeStore;
  passwords: PasswordHasher;
  isTrustedProxy: (address: string) => boolean;
  now: () => number;
}

export interface ServiceDependencies {
  config: ApiConfig;
  logger: Logger;
  db: Database;
  masterKey: Buffer;
  agent: AgentGateway;
  scryptParams?: ScryptParams;
  now?: () => number;
  /** Restarts the API after a staged database restore (only when supervised). */
  requestRestart?: () => void;
  /** Test hook: DNS resolution for integration requests. */
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export function createPasswordHasher(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): PasswordHasher {
  const dummy = createDummyVerifier(params);
  return {
    hash: (password) => hashPassword(password, params),
    verify: (password, hash) => verifyPassword(password, hash, params),
    dummyVerify: dummy,
  };
}

export function createLimiters(now: () => number): Limiters {
  const minute = 60_000;
  return {
    // Per source address: generous, catches password spraying from one client.
    loginIp: new FailureLimiter({
      maxFailures: 20,
      windowMs: 15 * minute,
      baseLockMs: 5 * minute,
      maxLockMs: 60 * minute,
      now,
    }),
    // Per account: progressive delay without permanent lockout (limits DoS on the admin account).
    loginUser: new FailureLimiter({
      maxFailures: 5,
      windowMs: 15 * minute,
      baseLockMs: minute,
      maxLockMs: 15 * minute,
      now,
    }),
    setupIp: new FailureLimiter({
      maxFailures: 5,
      windowMs: 15 * minute,
      baseLockMs: 5 * minute,
      maxLockMs: 60 * minute,
      now,
    }),
    // Re-authentication inside an existing session (password change, 2FA changes).
    sensitiveUser: new FailureLimiter({
      maxFailures: 5,
      windowMs: 15 * minute,
      baseLockMs: minute,
      maxLockMs: 15 * minute,
      now,
    }),
  };
}

export function createServices(deps: ServiceDependencies): Services {
  const now = deps.now ?? Date.now;
  const users = new UserRepository(deps.db, now);
  const secrets = new SecretBox(deriveKey(deps.masterKey, "otuken/secret-box/v1"));
  const catalogs = new CatalogService(deps.db, now);
  const audit = new AuditLog(deps.db, deps.logger, now);
  const notifications = new NotificationService({
    db: deps.db,
    logger: deps.logger,
    now,
    providers: [logProvider(deps.logger)],
  });
  const apps = new AppService({
    db: deps.db,
    agent: deps.agent,
    secrets,
    catalogs,
    audit,
    now,
    onJobFinished: (job) => notifyAppJob(notifications, job),
  });
  const integrations = new IntegrationService({
    db: deps.db,
    secrets,
    agent: deps.agent,
    now,
    appExists: (id) => apps.exists(id),
    ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
  });
  const docker = new DockerHub({ agent: deps.agent, logger: deps.logger, now });
  const widgetData = new DataHub({
    logger: deps.logger,
    now,
    providers: systemProviders(deps.agent, () => apps.managedProjects()),
    resolve: (topic) => integrations.provider(topic),
  });
  const updates = new UpdateService({
    db: deps.db,
    agent: deps.agent,
    audit,
    notifications,
    logger: deps.logger,
    now,
    onChanged: () => widgetData.refresh("data.apt"),
  });
  const files = new FileService({ ...deps.config.files, logger: deps.logger });
  const backups = new BackupService({
    db: deps.db,
    agent: deps.agent,
    apps,
    audit,
    notifications,
    logger: deps.logger,
    now,
    dir: deps.config.backups.dir,
    files,
    dataDir: deps.config.paths.dataDir,
    configFile: deps.config.configFile,
    reserveBytes: deps.config.backups.minFreeBytes,
    maxUploadBytes: deps.config.backups.maxUploadBytes,
    keyId: createHash("sha256")
      .update(deriveKey(deps.masterKey, "otuken/backup-key-id/v1"))
      .digest("hex")
      .slice(0, 32),
    supervised: deps.config.supervised,
    ...(deps.requestRestart ? { requestRestart: deps.requestRestart } : {}),
  });
  // Container widgets follow Docker changes while live views keep the event stream open.
  let dockerRefresh: NodeJS.Timeout | null = null;
  docker.onChange(() => {
    dockerRefresh ??= setTimeout(() => {
      dockerRefresh = null;
      widgetData.refresh("data.docker");
    }, 500);
    dockerRefresh.unref();
  });
  return {
    config: deps.config,
    logger: deps.logger,
    db: deps.db,
    users,
    preferences: new PreferenceRepository(deps.db, deps.logger, now),
    wallpapers: new WallpaperService(deps.db, deps.config.paths.dataDir, now),
    sessions: new SessionService(
      deps.db,
      {
        idleMs: deps.config.security.sessionIdleMs,
        maxAgeMs: deps.config.security.sessionMaxAgeMs,
      },
      deriveKey(deps.masterKey, "otuken/csrf/v1"),
      now,
    ),
    audit,
    setup: new SetupService({
      users,
      tokenFile: deps.config.paths.setupTokenFile,
      logger: deps.logger,
      revealTokenInLogs: deps.config.mode === "development",
    }),
    secrets,
    agent: deps.agent,
    metrics: new MetricsHub({ agent: deps.agent, logger: deps.logger, now }),
    docker,
    dockerProjects: new DockerProjectRepository(deps.db, now),
    catalogs,
    apps,
    integrations,
    widgetData,
    notifications,
    files,
    terminals: new TerminalService({ agent: deps.agent, logger: deps.logger, audit, now }),
    updates,
    tasks: new TaskService({
      db: deps.db,
      users,
      audit,
      notifications,
      logger: deps.logger,
      now,
      executors: taskExecutors({ agent: deps.agent, updates, apps, backups }),
    }),
    backups,
    hostMonitor: new HostMonitor({
      agent: deps.agent,
      notifications,
      logger: deps.logger,
      tailscale: {
        server: deps.config.server,
        isTrustedProxy: createProxyMatcher(deps.config.server.trustedProxies),
        now,
      },
    }),
    eventStreamHeartbeatMs: 15_000,
    limiters: createLimiters(now),
    challenges: new LoginChallengeStore(now),
    passwords: createPasswordHasher(deps.scryptParams),
    isTrustedProxy: createProxyMatcher(deps.config.server.trustedProxies),
    now,
  };
}

/** App installs, updates and other lifecycle results for people who can see apps. */
export function notifyAppJob(notifications: NotificationService, job: FinishedJob): void {
  const app = job.name.en ?? job.name.en_US ?? Object.values(job.name)[0] ?? job.appId;
  notifications.publish({
    kind: job.ok ? "app-succeeded" : "app-failed",
    severity: job.ok ? "success" : "critical",
    key: `${job.appId}:${job.action}`,
    params: {
      app,
      appId: job.appId,
      action: job.action,
      ...(job.error ? { reason: job.error } : {}),
      ...(job.ok ? {} : { rollback: job.rollback }),
    },
  });
}
