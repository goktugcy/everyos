import type { AgentClient } from "@otuken/agent-protocol";
import {
  createDummyVerifier,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
  type PasswordVerification,
  type ScryptParams,
} from "@otuken/auth";
import type { Database } from "@otuken/database";
import type { Logger } from "@otuken/logger";
import { deriveKey, SecretBox } from "@otuken/security";
import { createProxyMatcher, type ApiConfig } from "./config.ts";
import { AuditLog } from "./modules/audit/audit-log.ts";
import { LoginChallengeStore } from "./modules/auth/login-challenges.ts";
import { PreferenceRepository } from "./modules/preferences/preference-repository.ts";
import { FailureLimiter } from "./modules/auth/rate-limiter.ts";
import { SessionService } from "./modules/auth/session-service.ts";
import { SetupService } from "./modules/setup/setup-service.ts";
import { UserRepository } from "./modules/users/user-repository.ts";
import { WallpaperService } from "./modules/wallpapers/wallpaper-service.ts";

/** The subset of the agent client the HTTP layer depends on. */
export type AgentGateway = Pick<AgentClient, "state" | "call">;

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
    audit: new AuditLog(deps.db, deps.logger, now),
    setup: new SetupService({
      users,
      tokenFile: deps.config.paths.setupTokenFile,
      logger: deps.logger,
      revealTokenInLogs: deps.config.mode === "development",
    }),
    secrets: new SecretBox(deriveKey(deps.masterKey, "otuken/secret-box/v1")),
    agent: deps.agent,
    limiters: createLimiters(now),
    challenges: new LoginChallengeStore(now),
    passwords: createPasswordHasher(deps.scryptParams),
    isTrustedProxy: createProxyMatcher(deps.config.server.trustedProxies),
    now,
  };
}
