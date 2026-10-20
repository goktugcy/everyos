import { join } from "node:path";
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
import type { LocalServerKind } from "@everyos/shared";
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
import { DesktopAppsService } from "./modules/desktop-apps/desktop-apps.ts";
import type { FetcherFactory } from "./modules/desktop-apps/registries.ts";
import { PreferenceRepository } from "./modules/preferences/preference-repository.ts";
import { FailureLimiter } from "./modules/auth/rate-limiter.ts";
import { SessionService } from "./modules/auth/session-service.ts";
import { SetupService } from "./modules/setup/setup-service.ts";
import { UserRepository } from "./modules/users/user-repository.ts";
import { WallpaperService } from "./modules/wallpapers/wallpaper-service.ts";
import { CatalogService } from "./modules/catalogs/catalog-service.ts";
import { AppService, type FinishedJob } from "./modules/apps/app-service.ts";
import { AiAgentService } from "./modules/ai-agents/agent-service.ts";
import { LocalModelService } from "./modules/ai-agents/local-models.ts";
import { HostMonitor } from "./modules/notifications/host-monitor.ts";
import { DiskService } from "./modules/system/disks.ts";
import { TransferService } from "./modules/transfers/transfer-service.ts";
import { DriveService } from "./modules/drive/drive-service.ts";
import { GoogleHttp, type GoogleEndpoints } from "./modules/drive/google-http.ts";
import { ReleaseMonitor } from "./modules/notifications/release-monitor.ts";
import { FileService } from "./modules/files/file-service.ts";
import { TerminalService } from "./modules/terminal/terminal-service.ts";
import { UpdateService } from "./modules/updates/update-service.ts";
import { TaskService } from "./modules/tasks/task-service.ts";
import { taskExecutors } from "./modules/tasks/executors.ts";
import { BackupService } from "./modules/backups/backup-service.ts";
import { logProvider, NotificationService } from "./modules/notifications/notification-service.ts";
import {
  NotificationChannelService,
  type SmtpTransportFactory,
} from "./modules/notifications/channels.ts";
import { Keyring } from "./modules/backups/keyring.ts";
import {
  hostNamesFromNetwork,
  HttpsService,
  localHostNames,
} from "./modules/security/https-service.ts";
import { OffsiteService } from "./modules/backups/offsite/offsite-service.ts";
import type { S3ClientOptions } from "./modules/backups/offsite/s3-client.ts";
import { fileViewFor } from "./modules/files/file-view.ts";

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
  /** Desktop apps: registries, installations and the store (docs/app-sdk/architecture.md). */
  desktopApps: DesktopAppsService;
  aiAgents: AiAgentService;
  localModels: LocalModelService;
  integrations: IntegrationService;
  /** Shared, reference-counted widget data topics. */
  widgetData: DataHub;
  notifications: NotificationService;
  /** External delivery channels (ntfy, Telegram, e-mail, webhooks). */
  notificationChannels: NotificationChannelService;
  /** Disks mounted from Settings › Disks. */
  disks: DiskService;
  transfers: TransferService;
  drive: DriveService;
  files: FileService;
  terminals: TerminalService;
  updates: UpdateService;
  tasks: TaskService;
  backups: BackupService;
  /** Tailscale Serve and the local-network HTTPS listener with its certificate authority. */
  https: HttpsService;
  /** Where encrypted backup copies go (a disk, S3-compatible storage or Google Drive). */
  offsite: OffsiteService;
  /** Background host checks that raise and resolve notification conditions. */
  hostMonitor: HostMonitor;
  releaseMonitor: ReleaseMonitor;
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
  /** Test hook: loopback ports probed for local model servers. */
  localModelPorts?: ReadonlyArray<readonly [number, LocalServerKind]>;
  /** Test hook: SMTP transports for e-mail channels. */
  smtp?: SmtpTransportFactory;
  /** Test hook: the Telegram Bot API origin. */
  telegramApi?: string;
  /** Test hook: Google's OAuth and Drive endpoints (a local fake). */
  google?: GoogleEndpoints;
  /** Test hook: how desktop app registries and packages are fetched. */
  desktopAppFetcher?: FetcherFactory;
  /** Test hook: S3 client options for off-site backups. */
  s3?: S3ClientOptions;
}

/** The HTTPS service asks the agent for the host's addresses. */
const HTTPS_ACTOR = { kind: "system", component: "https" } as const;

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
  const notificationChannels = new NotificationChannelService({
    db: deps.db,
    secrets,
    audit,
    logger: deps.logger,
    now,
    ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
    ...(deps.smtp ? { smtp: deps.smtp } : {}),
    ...(deps.telegramApi ? { telegram: deps.telegramApi } : {}),
  });
  notifications.addProvider(notificationChannels.provider());
  const apps = new AppService({
    db: deps.db,
    agent: deps.agent,
    secrets,
    catalogs,
    audit,
    now,
    onJobFinished: (job) => notifyAppJob(notifications, job),
  });
  const localModels = new LocalModelService({
    db: deps.db,
    apps,
    agent: deps.agent,
    audit,
    now,
    ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
    ...(deps.localModelPorts ? { ports: deps.localModelPorts } : {}),
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
  const disks = new DiskService({
    agent: deps.agent,
    audit,
    logger: deps.logger,
    now,
    notifications,
  });
  const files = new FileService({
    ...deps.config.files,
    logger: deps.logger,
    extraRoots: () => disks.fileRoots(),
  });
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
    keyring: new Keyring(join(deps.config.paths.dataDir, "keys"), deps.masterKey),
    secrets,
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
  const drive = new DriveService({
    db: deps.db,
    secrets,
    http: new GoogleHttp(deps.google ? { endpoints: deps.google, allowPrivate: true } : {}),
    logger: deps.logger,
    audit,
    now,
  });
  const https = new HttpsService({
    db: deps.db,
    secrets,
    config: deps.config,
    logger: deps.logger,
    now,
    names: async () => {
      try {
        return hostNamesFromNetwork(await deps.agent.call("network.status", {}, HTTPS_ACTOR));
      } catch {
        return localHostNames();
      }
    },
  });
  const configuredProxy = createProxyMatcher(deps.config.server.trustedProxies);
  const isTrustedProxy = (address: string) =>
    configuredProxy(address) || https.trustsLoopbackProxy(address);
  // Disk copies are written like Files, as the administrator's Linux account.
  const offsite = new OffsiteService({
    db: deps.db,
    secrets,
    users,
    drive,
    disks,
    fileView: (who, options) => fileViewFor(services, who, options),
    logger: deps.logger,
    now,
    ...(deps.s3 ? { s3: deps.s3 } : {}),
  });
  backups.useOffsite(offsite);
  const services: Services = {
    config: deps.config,
    logger: deps.logger,
    db: deps.db,
    users,
    notificationChannels,
    disks,
    transfers: new TransferService({ now, logger: deps.logger, notifications }),
    drive,
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
    desktopApps: new DesktopAppsService({
      db: deps.db,
      secrets,
      logger: deps.logger,
      now,
      dir: deps.config.desktopApps.dir,
      anchors: {
        official: deps.config.desktopApps.officialRegistry,
        community: deps.config.desktopApps.communityRegistry,
      },
      ...(deps.desktopAppFetcher ? { fetcher: deps.desktopAppFetcher } : {}),
    }),
    integrations,
    aiAgents: new AiAgentService({
      db: deps.db,
      secrets,
      apps,
      agent: deps.agent,
      audit,
      local: localModels,
      now,
      ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
    }),
    localModels,
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
    offsite,
    releaseMonitor: new ReleaseMonitor({
      agent: deps.agent,
      notifications,
      logger: deps.logger,
      now,
    }),
    hostMonitor: new HostMonitor({
      agent: deps.agent,
      notifications,
      logger: deps.logger,
      tailscale: {
        server: {
          port: deps.config.server.port,
          get publicOrigins() {
            return https.origins();
          },
        },
        managed: () => https.settings().tailscale?.url ?? null,
        isTrustedProxy,
        now,
      },
      appUpdates: () => apps.catalogUpdates(),
    }),
    eventStreamHeartbeatMs: 15_000,
    limiters: createLimiters(now),
    challenges: new LoginChallengeStore(now),
    passwords: createPasswordHasher(deps.scryptParams),
    isTrustedProxy,
    https,
    now,
  };
  return services;
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
