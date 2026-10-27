import { installedVersion } from "@everyos/release";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Actor } from "@everyos/agent-protocol";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupAppContent,
  type BackupEncryptionView,
  type BackupJobStage,
  type BackupJobView,
  type BackupManifest,
  type BackupOverview,
  type BackupSettings,
  type BackupTrigger,
  type BackupVerification,
  type BackupView,
  type EncryptedUpload,
  type RestorePreview,
  type RestoreScope,
} from "@everyos/shared";
import { APP_DATA_CHUNK_BYTES, BackupSettingsSchema } from "@everyos/shared/schemas";
import { sinkTo } from "@everyos/system/archive";
import { toApiError } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import type { AgentGateway } from "../../services.ts";
import type { AppService } from "../apps/app-service.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { NotificationService } from "../notifications/notification-service.ts";
import type { FileService } from "../files/file-service.ts";
import { archiveHomes, restoreHomes, validateHomes } from "./homes.ts";
import {
  clearPassphraseKey,
  decryptBackup,
  derivePassphraseKey,
  encryptBackup,
  encryptedFileSize,
  encryptionView,
  looksEncrypted,
  passphraseMatches,
  PassphraseError,
  readEncryptedHeader,
  readPassphraseKey,
  unwrapDataKey,
  writePassphraseKey,
  type EncryptedHeader,
  type PassphraseKey,
} from "./encryption.ts";
import type { Keyring } from "./keyring.ts";
import {
  OFFSITE_FILE,
  offsiteName,
  offsiteReason,
  type OffsiteService,
} from "./offsite/offsite-service.ts";
import {
  BackupStore,
  invalidBackup,
  newBackupId,
  sha256File,
  type SpaceGuard,
} from "./backup-store.ts";
import {
  archiveWallpapers,
  archiveDesktopApps,
  inspectSnapshot,
  restoreDesktop,
  schemaVersionOf,
  snapshotDatabase,
  stageDatabaseRestore,
  withSnapshot,
} from "./snapshot.ts";

type UserActor = Extract<Actor, { kind: "user" }>;

const DEFAULT_SETTINGS: BackupSettings = { keep: 7, appData: [] };
const SETTINGS_KEY = "backups";

class Cancelled extends Error {}

/** A failure with a stable, displayable reason (stored on the job). */
class JobFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const reasonOf = (error: unknown): string => {
  if (error instanceof JobFailure) return error.reason;
  if (error instanceof Cancelled) return "cancelled";
  if (error instanceof ApiError) {
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    return reason ? `${error.code}:${reason}` : error.code;
  }
  const mapped = toApiError(error);
  const detail = (error as { message?: string }).message ?? "";
  if (detail.startsWith("APP_RUNNING")) return "BACKUP_APP_RUNNING";
  if (detail.startsWith("INSUFFICIENT_SPACE")) return "BACKUP_INSUFFICIENT_SPACE";
  return mapped.code;
};

export interface BackupServiceDependencies {
  db: Database;
  agent: AgentGateway;
  apps: AppService;
  audit: AuditLog;
  notifications: NotificationService;
  files: FileService;
  logger: Logger;
  now: () => number;
  dir: string;
  dataDir: string;
  /** Where desktop apps live (their kept packages go into backups). */
  desktopAppsDir?: string;
  configFile: string | null;
  reserveBytes: number;
  maxUploadBytes: number;
  /** The server secret and the earlier ones restores can use (BackupManifest.keyId). */
  keyring: Keyring;
  secrets: SecretBox;
  supervised: boolean;
  /** Restarts EveryOS (only when supervised) so a staged database restore is applied. */
  requestRestart?: () => void;
}

/**
 * Backup and restore (docs/backups.md). Jobs run one at a time in the
 * background, independent of the HTTP request that started them. Every
 * backup is checksummed and verified; app data is only captured while the
 * app is stopped; restores always take a safety backup first.
 */
export class BackupService {
  readonly #deps: BackupServiceDependencies;
  readonly #store: BackupStore;
  readonly #logger: Logger;
  #job: { view: BackupJobView; controller: AbortController; done: Promise<void> } | null = null;
  #lastJob: BackupJobView | null = null;
  #unavailable: string | null = null;
  readonly #tickets = new Map<
    string,
    { userId: string; backupId: string; encrypted: boolean; expires: number }
  >();
  /** Encrypted uploads waiting for their passphrase. */
  readonly #encryptedUploads = new Map<
    string,
    { path: string; header: EncryptedHeader; prefix: Buffer; at: number }
  >();
  #decrypting = false;
  #offsite: OffsiteService | null = null;

  constructor(deps: BackupServiceDependencies) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: "backups" });
    this.#store = new BackupStore({
      dir: deps.dir,
      keys: deps.keyring,
      reserveBytes: deps.reserveBytes,
    });
  }

  /** Off-site destinations (set once the services that reach them exist). */
  useOffsite(offsite: OffsiteService): void {
    this.#offsite = offsite;
  }

  /** Prepares the backup directory; problems disable backups with a reason instead of failing startup. */
  async start(): Promise<void> {
    try {
      await this.#store.ensure();
      await this.#store.cleanup();
      this.#unavailable = null;
    } catch (error) {
      this.#unavailable = (error as Error).message;
      this.#logger.error("Backups are unavailable", { error });
    }
  }

  stop(): void {
    this.#job?.controller.abort();
  }

  #available(): void {
    if (this.#unavailable)
      throw new ApiError(503, "HOST_CAPABILITY_UNAVAILABLE", "Backups are unavailable", {
        details: { reason: this.#unavailable },
      });
  }

  /* ------------------------------------------------------------ settings */

  settings(): BackupSettings {
    const row = this.#deps.db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      SETTINGS_KEY,
    );
    if (!row) return { ...DEFAULT_SETTINGS };
    const parsed = BackupSettingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  }

  updateSettings(settings: BackupSettings): BackupSettings {
    for (const id of settings.appData)
      if (this.#deps.apps.dataSupport(id) !== "supported")
        throw new ApiError(400, "VALIDATION_FAILED", "This app's data cannot be backed up", {
          details: { appId: id },
        });
    this.#deps.db.run(
      `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      SETTINGS_KEY,
      JSON.stringify(settings),
      this.#deps.now(),
    );
    return this.settings();
  }

  /* ---------------------------------------------------------------- views */

  job(): BackupJobView | null {
    return this.#job ? { ...this.#job.view } : null;
  }

  lastJob(): BackupJobView | null {
    return this.#lastJob;
  }

  async list(): Promise<BackupView[]> {
    this.#available();
    return this.#store.list();
  }

  async get(id: string): Promise<BackupView> {
    this.#available();
    return this.#store.view(id);
  }

  async overview(actor: UserActor): Promise<BackupOverview> {
    const installed = await this.#deps.apps.list(actor).catch(() => null);
    const apps = (
      installed ?? this.#deps.apps.managedProjects().map((app) => ({ ...app, state: "unknown" }))
    ).map((app) => ({
      id: app.id,
      name: app.name,
      state: app.state,
      data: this.#deps.apps.dataSupport(app.id) ?? "unsupported",
    }));
    const usage = this.#unavailable ? { freeBytes: null, usedBytes: 0 } : await this.#store.usage();
    return {
      backups: this.#unavailable ? [] : await this.#store.list(),
      job: this.job(),
      lastJob: this.#lastJob,
      settings: this.settings(),
      apps,
      storage: {
        location: this.#deps.dir,
        freeBytes: usage.freeBytes,
        usedBytes: usage.usedBytes,
        reserveBytes: this.#deps.reserveBytes,
      },
      supervised: this.#deps.supervised,
    };
  }

  /* ----------------------------------------------------------------- jobs */

  #startJob(
    kind: BackupJobView["kind"],
    trigger: BackupTrigger,
    actor: UserActor,
    backupId: string | null,
    run: (job: BackupJobView, signal: AbortSignal) => Promise<void>,
  ): BackupJobView {
    this.#available();
    if (this.#job) throw new ApiError(409, "BACKUP_BUSY", "Another backup job is running");
    const view: BackupJobView = {
      id: randomBytes(8).toString("hex"),
      kind,
      trigger,
      status: "running",
      stage: "preparing",
      appId: null,
      bytes: 0,
      startedAt: this.#deps.now(),
      finishedAt: null,
      username: actor.username,
      backupId,
      error: null,
      restart: null,
    };
    const controller = new AbortController();
    const done = (async () => {
      try {
        await run(view, controller.signal);
        view.status = "succeeded";
      } catch (error) {
        view.status = controller.signal.aborted ? "cancelled" : "failed";
        view.error = controller.signal.aborted ? "cancelled" : reasonOf(error);
        if (!controller.signal.aborted)
          this.#logger.warn("Backup job failed", { kind, error: view.error, cause: error });
      } finally {
        view.stage = "done";
        view.appId = null;
        view.finishedAt = this.#deps.now();
        this.#lastJob = { ...view };
        this.#job = null;
      }
    })();
    this.#job = { view, controller, done };
    return { ...view };
  }

  /** Resolves when the job has finished (scheduled tasks wait for their backup). */
  async wait(jobId: string, signal?: AbortSignal): Promise<BackupJobView> {
    const current = this.#job;
    if (current && current.view.id === jobId) {
      const abort = () => current.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await current.done;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
    if (this.#lastJob?.id === jobId) return this.#lastJob;
    throw new ApiError(404, "NOT_FOUND", "Backup job not found");
  }

  cancel(): boolean {
    if (!this.#job) return false;
    this.#job.controller.abort();
    return true;
  }

  /* --------------------------------------------------------------- backup */

  create(
    options: { apps: string[]; note?: string; trigger: "manual" | "schedule" },
    actor: UserActor,
  ): BackupJobView {
    const apps = [...new Set(options.apps)];
    for (const id of apps)
      if (this.#deps.apps.dataSupport(id) !== "supported")
        throw new ApiError(400, "VALIDATION_FAILED", "This app's data cannot be backed up", {
          details: { appId: id },
        });
    return this.#startJob("backup", options.trigger, actor, null, async (job, signal) => {
      const id = await this.#backup(job, signal, actor, {
        trigger: options.trigger,
        apps,
        note: options.note ?? null,
      });
      job.backupId = id;
      await this.prune();
      if (this.#offsiteReady() && this.#offsite?.settings().auto) {
        job.stage = "offsite";
        // The backup itself succeeded; a failed copy is recorded, notified and retried later.
        await this.#copyOffsite(id, job, signal, actor).catch((error: unknown) => {
          if (signal.aborted) throw error;
        });
      }
    });
  }

  /** Creates one backup; returns its id. Used by manual, scheduled and safety backups. */
  async #backup(
    job: BackupJobView,
    signal: AbortSignal,
    actor: UserActor,
    options: { trigger: BackupTrigger; apps: string[]; note: string | null },
  ): Promise<string> {
    const { db, now } = this.#deps;
    const stage = (name: BackupJobStage, appId: string | null = null) => {
      if (signal.aborted) throw new Cancelled();
      job.stage = name;
      job.appId = appId;
    };
    const id = newBackupId(now());
    const guard = this.#store.guard();
    const databaseSize = await stat(db.path)
      .then((info) => info.size)
      .catch(() => 0);
    const work = await this.#store.begin(id);
    let ok = false;
    try {
      await guard.require(databaseSize);
      stage("database");
      const schemaVersion = await snapshotDatabase(db, join(work, "everyos.db.gz"), work);
      const summary = await withSnapshot(join(work, "everyos.db.gz"), work, inspectSnapshot);
      if (!summary.ok) throw new JobFailure("snapshot-integrity");
      stage("files");
      let config = false;
      if (this.#deps.configFile) {
        try {
          await copyFile(this.#deps.configFile, join(work, "config.yaml"), constants.COPYFILE_EXCL);
          config = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            this.#logger.warn("Configuration file not included in the backup", { error });
        }
      }
      const wallpapers =
        (await archiveWallpapers(
          join(this.#deps.dataDir, "wallpapers"),
          join(work, "wallpapers.tar.gz"),
        )) > 0;
      const desktopApps = this.#deps.desktopAppsDir
        ? await archiveDesktopApps(
            join(this.#deps.desktopAppsDir, "packages"),
            join(work, "desktop-apps.tar.gz"),
          )
        : [];
      const apps: BackupAppContent[] = [];
      const homes = await this.#deps.files.withHomesLocked(
        summary.users.map((user) => user.id),
        () =>
          archiveHomes({
            root: this.#deps.files.homesDir,
            users: summary.users,
            target: join(work, "homes.tar.gz"),
            guard,
            signal,
            progress: (bytes) => {
              job.bytes += bytes;
            },
          }),
      );
      for (const appId of options.apps) {
        const content = await this.#backupApp(appId, work, job, signal, actor, guard, stage);
        if (content) apps.push(content);
      }
      // App records without data are listed too, so a preview can show them.
      stage("verify");
      const files = [];
      for (const name of [
        "everyos.db.gz",
        ...(config ? ["config.yaml"] : []),
        ...(wallpapers ? ["wallpapers.tar.gz"] : []),
        ...(homes.length ? ["homes.tar.gz"] : []),
        ...(desktopApps.length ? ["desktop-apps.tar.gz"] : []),
        ...apps.filter((app) => app.data).map((app) => `apps/${app.id}.data.tar.gz`),
      ]) {
        const path = join(work, name);
        files.push({ name, size: (await stat(path)).size, sha256: await sha256File(path) });
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_FORMAT_VERSION,
        id,
        createdAt: now(),
        trigger: options.trigger,
        createdBy: actor.username,
        note: options.note,
        everyosVersion: installedVersion(),
        schemaVersion,
        hostname: hostname().slice(0, 255),
        keyId: this.#deps.keyring.currentId,
        contents: { database: true, config, wallpapers, apps, homes, desktopApps },
        files,
      };
      await this.#store.publish(work, manifest, {
        verification: { at: now(), ok: true, error: null },
      });
      ok = true;
      this.#deps.audit.record({
        action: "backups.create",
        outcome: "success",
        actor: { userId: actor.userId, username: actor.username },
        ip: actor.ip ?? null,
        target: id,
        details: {
          trigger: options.trigger,
          apps: apps.map((app) => app.id),
          size: files.reduce((sum, file) => sum + file.size, 0),
        },
      });
      if (options.trigger !== "pre-restore")
        this.#deps.notifications.publish({
          kind: "backup-succeeded",
          severity: "success",
          key: options.trigger,
          params: { backup: id },
        });
      return id;
    } catch (error) {
      if (!ok) {
        await this.#store.discard(work);
        this.#deps.audit.record({
          action: "backups.create",
          outcome: "failure",
          actor: { userId: actor.userId, username: actor.username },
          ip: actor.ip ?? null,
          details: { trigger: options.trigger, reason: reasonOf(error) },
        });
        if (!signal.aborted)
          this.#deps.notifications.publish({
            kind: "backup-failed",
            severity: "critical",
            key: options.trigger,
            params: { reason: reasonOf(error) },
          });
      }
      throw error;
    }
  }

  /** Captures one app's data, stopping and restarting it around the copy when it runs. */
  async #backupApp(
    appId: string,
    work: string,
    job: BackupJobView,
    signal: AbortSignal,
    actor: UserActor,
    guard: SpaceGuard,
    stage: (name: BackupJobStage, appId?: string | null) => void,
  ): Promise<BackupAppContent | null> {
    const record = this.#deps.apps.managedProjects().find((app) => app.id === appId);
    if (!record || this.#deps.apps.dataSupport(appId) !== "supported") return null;
    const target = join(work, "apps", `${appId}.data.tar.gz`);
    const wasRunning = await this.#appRunning(appId, actor);
    try {
      if (wasRunning) {
        stage("app-stop", appId);
        await this.#appAction(appId, "stop", actor, signal);
      }
      stage("app-data", appId);
      const result = await this.#exportAppData(appId, target, actor, signal, guard, (bytes) => {
        job.bytes += bytes;
      });
      return { id: appId, name: record.name, data: true, ...result };
    } finally {
      if (wasRunning) {
        job.stage = "app-start";
        job.appId = appId;
        // Even after a failure or cancellation the app must come back.
        await this.#appAction(appId, "start", actor, new AbortController().signal).catch(
          (error: unknown) => {
            this.#logger.error("Could not restart the app after its backup", { appId, error });
          },
        );
      }
    }
  }

  async #appRunning(appId: string, actor: UserActor): Promise<boolean> {
    const apps = await this.#deps.apps.list(actor);
    const app = apps.find((entry) => entry.id === appId);
    if (app?.state === "busy") throw new JobFailure("app-busy");
    return app?.state === "running" || app?.state === "degraded";
  }

  async #appAction(
    appId: string,
    action: "stop" | "start",
    actor: UserActor,
    signal: AbortSignal,
  ): Promise<void> {
    const started = await this.#deps.apps.control(appId, action, actor);
    for (;;) {
      const current = this.#deps.apps.job(started.id);
      if (current?.stage === "succeeded") return;
      if (current?.stage === "failed") throw new JobFailure(`app-${action}-failed`);
      if (signal.aborted) throw new Cancelled();
      await sleep(250, signal);
    }
  }

  async #exportAppData(
    appId: string,
    target: string,
    actor: UserActor,
    signal: AbortSignal,
    guard: SpaceGuard,
    progress: (bytes: number) => void,
  ): Promise<{ dataBytes: number; dataEntries: number; skipped: number }> {
    const { agent } = this.#deps;
    const begin = await agent.call("backups.appdata.export.begin", { id: appId }, actor, {
      signal,
    });
    const hash = createHash("sha256");
    let size = 0;
    try {
      // The compressed archive is at most about as large as the data itself.
      await guard.require(begin.bytes);
      const handle = await open(target, "wx", 0o600);
      try {
        for (;;) {
          if (signal.aborted) throw new Cancelled();
          const part = await agent.call(
            "backups.appdata.export.read",
            { token: begin.token },
            actor,
            { signal },
          );
          if (part.done) {
            if (part.size !== size || part.sha256 !== hash.digest("hex"))
              throw new JobFailure("transfer-checksum");
            break;
          }
          const bytes = Buffer.from(part.data, "base64");
          await handle.write(bytes);
          hash.update(bytes);
          size += bytes.length;
          progress(bytes.length);
          await guard.wrote(bytes.length);
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      await agent
        .call("backups.appdata.export.abort", { token: begin.token }, actor)
        .catch(() => undefined);
      throw error;
    }
    return { dataBytes: begin.bytes, dataEntries: begin.entries, skipped: begin.skipped };
  }

  /** Removes the oldest unpinned backups beyond the retention count (not safety backups in use). */
  async prune(): Promise<number> {
    if (this.#unavailable) return 0;
    const { keep } = this.settings();
    const candidates = (await this.#store.list()).filter((backup) => !backup.pinned);
    let removed = 0;
    for (const backup of candidates.slice(keep)) {
      if (this.#job?.view.backupId === backup.id && this.#job.view.kind === "restore") continue;
      await this.#store.remove(backup.id);
      removed++;
    }
    if (removed) this.#logger.info("Old backups removed by retention", { removed, keep });
    return removed;
  }

  /* --------------------------------------------------------- verification */

  async #check(id: string): Promise<{
    verification: BackupVerification;
    summary: ReturnType<typeof inspectSnapshot> | null;
  }> {
    let problem = await this.#store.checkFiles(id);
    const manifest = await this.#store.manifest(id);
    if (!problem && manifest.contents.homes?.length) {
      try {
        await validateHomes(this.#store.file(id, "homes.tar.gz"), manifest.contents.homes);
      } catch {
        problem = "homes:homes.tar.gz";
      }
    }
    const summary = problem
      ? null
      : await withSnapshot(await this.#store.databaseFile(id), this.#store.dir, inspectSnapshot);
    const verification: BackupVerification = {
      at: this.#deps.now(),
      ok: !problem && Boolean(summary?.ok),
      error: problem ?? (summary?.ok ? null : "database"),
    };
    await this.#store.setVerification(id, verification);
    return { verification, summary };
  }

  async verify(id: string): Promise<BackupVerification> {
    this.#available();
    await this.#store.manifest(id);
    return (await this.#check(id)).verification;
  }

  async preview(id: string): Promise<RestorePreview> {
    this.#available();
    const manifest = await this.#store.manifest(id);
    const { verification, summary } = await this.#check(id);
    const backup = await this.#store.view(id);
    const { db } = this.#deps;
    const currentSchema = schemaVersionOf(db);
    const currentUsers = db.all<{ id: string; username: string; role: string }>(
      "SELECT id, username, role FROM users ORDER BY username",
    );
    const currentApps = this.#deps.apps.managedProjects();
    const usersIn = summary?.users ?? [];
    const users = [
      ...usersIn.map((user) => ({
        username: user.username,
        role: user.role,
        status: currentUsers.some((current) => current.username === user.username)
          ? ("same" as const)
          : ("added" as const),
      })),
      ...currentUsers
        .filter((current) => !usersIn.some((user) => user.username === current.username))
        .map((user) => ({ username: user.username, role: user.role, status: "removed" as const })),
    ];
    const appsIn = summary?.apps ?? [];
    const apps = [
      ...appsIn.map((app) => ({
        id: app.id,
        name: app.name,
        status: currentApps.some((current) => current.id === app.id)
          ? ("same" as const)
          : ("added" as const),
      })),
      ...currentApps
        .filter((current) => !appsIn.some((app) => app.id === current.id))
        .map((app) => ({ id: app.id, name: app.name, status: "removed" as const })),
    ];
    let config: RestorePreview["config"] = "absent";
    if (manifest.contents.config) {
      const saved = await readFile(this.#store.file(id, "config.yaml"), "utf8");
      const current = this.#deps.configFile
        ? await readFile(this.#deps.configFile, "utf8").catch(() => null)
        : null;
      config = saved === current ? "same" : "different";
    }
    const desktopUsers = currentUsers
      .filter((user) => summary?.desktopUsers.includes(user.id))
      .map((user) => user.username);
    return {
      backup,
      verification,
      databaseBlocked: !verification.ok
        ? "invalid"
        : summary!.schemaVersion > currentSchema
          ? "newer-schema"
          : !backup.keyAvailable
            ? "different-key"
            : null,
      database: {
        schemaVersion: summary?.schemaVersion ?? manifest.schemaVersion,
        currentSchemaVersion: currentSchema,
        users,
        apps,
        tasks: summary?.tasks ?? 0,
        catalogs: summary?.catalogs ?? 0,
      },
      desktopUsers,
      homes: (manifest.contents.homes ?? []).map((home) => ({
        ...home,
        restorable: !this.#deps.files.homesDir
          ? ("disabled" as const)
          : currentUsers.some((user) => user.id === home.userId)
            ? ("ok" as const)
            : ("not-found" as const),
      })),
      config,
      apps: manifest.contents.apps
        .filter((app) => app.data)
        .map((app) => {
          const support = this.#deps.apps.dataSupport(app.id);
          return {
            id: app.id,
            name: app.name,
            restorable:
              support === null
                ? ("not-installed" as const)
                : support === "supported"
                  ? ("ok" as const)
                  : ("unsupported" as const),
            dataBytes: app.dataBytes,
          };
        }),
    };
  }

  /* -------------------------------------------------------------- restore */

  restore(
    id: string,
    request: { settings: "none" | RestoreScope; apps: string[]; homes?: boolean },
    actor: UserActor,
  ): BackupJobView {
    return this.#startJob("restore", "manual", actor, id, async (job, signal) => {
      const stage = (name: BackupJobStage, appId: string | null = null) => {
        if (signal.aborted) throw new Cancelled();
        job.stage = name;
        job.appId = appId;
      };
      let outcome: "success" | "failure" = "failure";
      try {
        stage("verify");
        const preview = await this.preview(id);
        if (!preview.verification.ok) throw invalidBackup(preview.verification.error ?? "invalid");
        if (request.settings === "database" && preview.databaseBlocked)
          throw new ApiError(
            409,
            "BACKUP_INCOMPATIBLE",
            "This backup cannot replace the database",
            {
              details: { reason: preview.databaseBlocked },
            },
          );
        if (request.settings === "desktop" && preview.desktopUsers.length === 0)
          throw new JobFailure("no-desktop-users");
        for (const appId of request.apps)
          if (preview.apps.find((app) => app.id === appId)?.restorable !== "ok")
            throw new JobFailure(`app-not-restorable:${appId}`);
        const homeUsers = request.homes
          ? preview.homes.filter((home) => home.restorable === "ok").map((home) => home.userId)
          : [];
        if (request.homes && !homeUsers.length) throw new JobFailure("no-home-users");

        // Always keep a way back: the current state, including the data being replaced.
        stage("safety");
        const safety = await this.#backup(job, signal, actor, {
          trigger: "pre-restore",
          apps: request.apps,
          note: id,
        });

        if (request.homes) {
          stage("restore-data");
          if (
            (await this.#store.manifest(safety)).contents.homes?.some(
              (home) => homeUsers.includes(home.userId) && home.skipped > 0,
            )
          )
            throw new JobFailure("home-unsupported");
          await this.#deps.files.withHomesLocked(homeUsers, () =>
            restoreHomes({
              archive: this.#store.file(id, "homes.tar.gz"),
              root: this.#deps.files.homesDir!,
              homes: preview.homes,
              users: homeUsers,
              reserveBytes: this.#deps.reserveBytes,
              signal,
            }),
          );
        }

        for (const appId of request.apps) {
          const wasRunning = await this.#appRunning(appId, actor);
          try {
            if (wasRunning) {
              stage("app-stop", appId);
              await this.#appAction(appId, "stop", actor, signal);
            }
            stage("restore-data", appId);
            await this.#importAppData(
              appId,
              this.#store.file(id, `apps/${appId}.data.tar.gz`),
              (await this.#store.manifest(id)).files.find(
                (file) => file.name === `apps/${appId}.data.tar.gz`,
              )!.sha256,
              actor,
              signal,
              (bytes) => {
                job.bytes += bytes;
              },
            );
          } finally {
            if (wasRunning) {
              job.stage = "app-start";
              job.appId = appId;
              await this.#appAction(appId, "start", actor, new AbortController().signal).catch(
                (error: unknown) => {
                  this.#logger.error("Could not restart the app after its restore", {
                    appId,
                    error,
                  });
                },
              );
            }
          }
        }

        const wallpapers = (await this.#store.manifest(id)).contents.wallpapers
          ? this.#store.file(id, "wallpapers.tar.gz")
          : null;
        if (request.settings === "desktop") {
          stage("restore-settings");
          await withSnapshot(await this.#store.databaseFile(id), this.#store.dir, (snapshot) =>
            restoreDesktop({
              db: this.#deps.db,
              snapshot,
              wallpapersArchive: wallpapers,
              wallpapersDir: join(this.#deps.dataDir, "wallpapers"),
              now: this.#deps.now(),
            }),
          );
        } else if (request.settings === "database") {
          stage("stage-database");
          const { keyId } = await this.#store.manifest(id);
          await stageDatabaseRestore({
            dataDir: this.#deps.dataDir,
            snapshotGz: await this.#store.databaseFile(id),
            wallpapersArchive: wallpapers,
            desktopAppsArchive: (await this.#store.manifest(id)).contents.desktopApps?.length
              ? this.#store.file(id, "desktop-apps.tar.gz")
              : null,
            secretKey:
              keyId === this.#deps.keyring.currentId ? null : this.#deps.keyring.get(keyId),
            pending: { backupId: id, requestedBy: actor.username, requestedAt: this.#deps.now() },
          });
          job.restart = this.#deps.supervised ? "automatic" : "manual";
        }
        outcome = "success";
        this.#deps.audit.record({
          action: "backups.restore",
          outcome,
          actor: { userId: actor.userId, username: actor.username },
          ip: actor.ip ?? null,
          target: id,
          details: {
            settings: request.settings,
            apps: request.apps,
            homes: request.homes ?? false,
            safetyBackup: safety,
          },
        });
        if (job.restart === "automatic") {
          this.#logger.warn("Restarting EveryOS to apply the restored database", { backupId: id });
          const timer = setTimeout(() => this.#deps.requestRestart?.(), 1_500);
          timer.unref();
        }
      } finally {
        if (outcome === "failure")
          this.#deps.audit.record({
            action: "backups.restore",
            outcome,
            actor: { userId: actor.userId, username: actor.username },
            ip: actor.ip ?? null,
            target: id,
            details: {
              settings: request.settings,
              apps: request.apps,
              homes: request.homes ?? false,
            },
          });
      }
    });
  }

  async #importAppData(
    appId: string,
    archive: string,
    sha256: string,
    actor: UserActor,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<void> {
    const { agent } = this.#deps;
    const size = (await lstat(archive)).size;
    const { token } = await agent.call("backups.appdata.import.begin", { id: appId, size }, actor, {
      signal,
    });
    try {
      let offset = 0;
      for await (const raw of createReadStream(archive, { highWaterMark: APP_DATA_CHUNK_BYTES })) {
        if (signal.aborted) throw new Cancelled();
        const chunk = raw as Buffer;
        await agent.call(
          "backups.appdata.import.chunk",
          { token, offset, data: chunk.toString("base64") },
          actor,
          { signal },
        );
        offset += chunk.length;
        progress(chunk.length);
      }
      await agent.call("backups.appdata.import.commit", { token, sha256 }, actor, { signal });
    } catch (error) {
      await agent.call("backups.appdata.import.abort", { token }, actor).catch(() => undefined);
      throw error;
    }
  }

  /* ----------------------------------------------------- manage & transfer */

  async remove(id: string): Promise<void> {
    this.#available();
    if (this.#job?.view.backupId === id)
      throw new ApiError(409, "BACKUP_BUSY", "The backup is in use");
    await this.#store.remove(id);
  }

  async pin(id: string, pinned: boolean): Promise<BackupView> {
    this.#available();
    return this.#store.setPinned(id, pinned);
  }

  /** A single-use, short-lived download link for an already re-authenticated user. */
  async issueTicket(id: string, userId: string, encrypted = false): Promise<string> {
    this.#available();
    await this.#store.manifest(id);
    if (encrypted) this.#passphraseKey();
    const now = this.#deps.now();
    for (const [key, ticket] of this.#tickets) if (ticket.expires < now) this.#tickets.delete(key);
    const ticket = randomBytes(24).toString("base64url");
    this.#tickets.set(ticket, { userId, backupId: id, encrypted, expires: now + 60_000 });
    return ticket;
  }

  /** The ticket's download, or null when it is not valid for this backup and user. */
  redeemTicket(ticket: string, id: string, userId: string): { encrypted: boolean } | null {
    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    return entry &&
      entry.userId === userId &&
      entry.backupId === id &&
      entry.expires >= this.#deps.now()
      ? { encrypted: entry.encrypted }
      : null;
  }

  /** The backup as a tar archive, or encrypted with the passphrase (then with its secret). */
  async download(
    id: string,
    options: { encrypted?: boolean } = {},
  ): Promise<{
    size: number;
    name: string;
    write: (sink: (chunk: Buffer) => Promise<void>) => Promise<void>;
  }> {
    this.#available();
    if (!options.encrypted) return this.#store.download(id);
    const encrypted = await this.#encrypted(id, this.#passphraseKey());
    return {
      size: encrypted.size,
      name: offsiteName(id),
      write: async (sink) => {
        for await (const chunk of encrypted.stream()) await sink(chunk);
      },
    };
  }

  /**
   * Imports an uploaded archive. An encrypted one is kept aside until its passphrase is given
   * (`decryptUpload`), so a mistyped passphrase does not mean uploading it again.
   */
  async upload(
    source: AsyncIterable<Buffer | Uint8Array>,
    length: number,
  ): Promise<BackupView | EncryptedUpload> {
    this.#available();
    if (length > this.#deps.maxUploadBytes)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The backup is larger than allowed");
    await this.#store.guard().require(length);
    const iterator = source[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    while (head.length < 8) {
      const next = await iterator.next();
      if (next.done) break;
      head = Buffer.concat([head, Buffer.from(next.value)]);
    }
    const rest = (async function* () {
      if (head.length) yield head;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield Buffer.from(next.value);
      }
    })();
    if (looksEncrypted(head)) return this.#stageEncrypted(rest, length);
    const { id } = await this.#store.importArchive(rest, length);
    await this.#check(id);
    return this.#store.view(id);
  }

  async #stageEncrypted(source: AsyncIterable<Buffer>, length: number): Promise<EncryptedUpload> {
    const now = this.#deps.now();
    for (const [uploadId, pending] of this.#encryptedUploads)
      if (now - pending.at > 6 * 60 * 60_000) await this.discardUpload(uploadId);
    const uploadId = randomBytes(16).toString("hex");
    const path = join(this.#store.dir, `.encrypted-${uploadId}`);
    const guard = this.#store.guard();
    const handle = await open(path, "wx", 0o600);
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > length) throw invalidBackup("encrypted-length");
        if (head.length < 64 * 1024 + 12)
          head = Buffer.concat([head, chunk.subarray(0, 64 * 1024 + 12 - head.length)]);
        await handle.write(chunk);
        await guard.wrote(chunk.length);
      }
      if (size !== length) throw invalidBackup("encrypted-length");
      const parsed = readEncryptedHeader(head);
      if (!parsed || encryptedFileSize(parsed.header, parsed.prefix) !== size)
        throw invalidBackup("encrypted-length");
      this.#encryptedUploads.set(uploadId, { path, ...parsed, at: now });
      return {
        encrypted: true,
        uploadId,
        backupId: parsed.header.backupId,
        createdAt: parsed.header.createdAt,
        hostname: parsed.header.hostname,
        everyosVersion: parsed.header.everyosVersion,
        includesKey: parsed.header.includesKey,
      };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  /** Opens an encrypted upload with its passphrase and imports it (with its server secret). */
  async decryptUpload(uploadId: string, passphrase: string): Promise<BackupView> {
    this.#available();
    const pending = this.#encryptedUploads.get(uploadId);
    if (!pending) throw new ApiError(404, "NOT_FOUND", "Upload not found");
    // One at a time: each attempt costs a scrypt derivation of about 128 MiB.
    if (this.#decrypting) throw new ApiError(409, "BACKUP_BUSY", "Another upload is being opened");
    this.#decrypting = true;
    try {
      let dataKey: Buffer;
      try {
        dataKey = await unwrapDataKey(pending.header, passphrase);
      } catch (error) {
        if (error instanceof PassphraseError)
          throw new ApiError(400, "BACKUP_PASSPHRASE_INVALID", "The passphrase is wrong");
        throw error;
      }
      const { id, key } = await this.#store.importArchive(
        decryptBackup(
          createReadStream(pending.path, { start: pending.prefix.length }),
          pending.header,
          pending.prefix,
          dataKey,
        ),
        pending.header.plaintextSize,
        { acceptKey: true },
      );
      if (id !== pending.header.backupId) {
        await this.#store.remove(id);
        throw invalidBackup("encrypted-header");
      }
      if (key) this.#deps.keyring.add(key);
      await this.discardUpload(uploadId);
      await this.#check(id);
      return this.#store.view(id);
    } finally {
      this.#decrypting = false;
    }
  }

  async discardUpload(uploadId: string): Promise<void> {
    const pending = this.#encryptedUploads.get(uploadId);
    this.#encryptedUploads.delete(uploadId);
    if (pending) await rm(pending.path, { force: true });
  }

  /* ------------------------------------------------- encryption and off-site */

  encryption(): BackupEncryptionView {
    return encryptionView(this.#deps.db);
  }

  /** Sets (or replaces) the passphrase; earlier encrypted copies keep needing the old one. */
  async setPassphrase(passphrase: string, actor: UserActor): Promise<BackupEncryptionView> {
    const key = await derivePassphraseKey(passphrase);
    writePassphraseKey(this.#deps.db, this.#deps.secrets, key, actor.username, this.#deps.now());
    return this.encryption();
  }

  /** Removes the passphrase; copies already made keep opening with it. */
  clearPassphrase(): BackupEncryptionView {
    clearPassphraseKey(this.#deps.db);
    return this.encryption();
  }

  async checkPassphrase(passphrase: string): Promise<boolean> {
    return passphraseMatches(this.#passphraseKey(), passphrase);
  }

  /** The current server secret, for an administrator keeping it somewhere safe. */
  secretKey(): Buffer {
    return this.#deps.keyring.current;
  }

  #passphraseKey(): PassphraseKey {
    const key = readPassphraseKey(this.#deps.db, this.#deps.secrets);
    if (!key) throw new ApiError(409, "BACKUP_ENCRYPTION_REQUIRED", "No backup passphrase is set");
    return key;
  }

  #offsiteReady(): boolean {
    return Boolean(
      this.#offsite?.settings().target && readPassphraseKey(this.#deps.db, this.#deps.secrets),
    );
  }

  /** An encrypted copy of a backup: its exact size and a fresh stream of it. */
  async #encrypted(id: string, key: PassphraseKey) {
    const manifest = await this.#store.manifest(id);
    const backupKey = this.#deps.keyring.get(manifest.keyId);
    const plain = await this.#store.download(id, { key: backupKey });
    const encrypted = encryptBackup(
      key,
      {
        backupId: id,
        createdAt: manifest.createdAt,
        everyosVersion: manifest.everyosVersion,
        hostname: manifest.hostname,
        includesKey: backupKey !== null,
      },
      plain.size,
    );
    return {
      size: encrypted.size,
      async *stream(): AsyncGenerator<Buffer> {
        const pass = new PassThrough();
        plain.write(sinkTo(pass)).then(
          () => pass.end(),
          (error: unknown) => pass.destroy(error as Error),
        );
        try {
          yield* encrypted.encrypt(pass);
        } finally {
          pass.destroy();
        }
      },
    };
  }

  /** Sends a backup off-site now. */
  offsiteCopy(id: string, actor: UserActor): BackupJobView {
    if (!this.#offsite?.settings().target)
      throw new ApiError(409, "BACKUP_OFFSITE_NOT_CONFIGURED", "No off-site destination is set");
    this.#passphraseKey();
    return this.#startJob("offsite", "manual", actor, id, async (job, signal) => {
      await this.#store.manifest(id);
      job.stage = "offsite";
      await this.#copyOffsite(id, job, signal, actor);
    });
  }

  /** Encrypts and uploads one backup, then keeps the newest copies there (see `keep`). */
  async #copyOffsite(
    id: string,
    job: BackupJobView,
    signal: AbortSignal,
    actor: UserActor,
  ): Promise<void> {
    const offsite = this.#offsite!;
    const name = offsiteName(id);
    let label = "";
    try {
      const destination = await offsite.open(signal);
      label = destination.label;
      const encrypted = await this.#encrypted(id, this.#passphraseKey());
      await destination.put(name, encrypted.stream(), encrypted.size, signal, (bytes) => {
        job.bytes += bytes;
      });
      await this.#store.setOffsite(id, {
        at: this.#deps.now(),
        ok: true,
        target: label,
        name,
        error: null,
      });
      this.#deps.audit.record({
        action: "backups.offsite",
        outcome: "success",
        actor: { userId: actor.userId, username: actor.username },
        ip: actor.ip ?? null,
        target: id,
        details: { destination: label, size: encrypted.size },
      });
      // Retention there: the newest copies by backup id (which sorts by time).
      const { keep } = offsite.settings();
      const copies = (await destination.list(signal))
        .filter((candidate) => OFFSITE_FILE.test(candidate))
        .sort()
        .reverse();
      for (const old of copies.slice(keep)) {
        if (old === name) continue;
        await destination
          .remove(old, signal)
          .catch((error: unknown) =>
            this.#logger.warn("Old off-site copy not removed", { name: old, error }),
          );
      }
    } catch (error) {
      const reason = signal.aborted ? "cancelled" : offsiteReason(error);
      await this.#store
        .setOffsite(id, { at: this.#deps.now(), ok: false, target: label, name, error: reason })
        .catch(() => undefined);
      this.#deps.audit.record({
        action: "backups.offsite",
        outcome: "failure",
        actor: { userId: actor.userId, username: actor.username },
        ip: actor.ip ?? null,
        target: id,
        details: { destination: label, reason },
      });
      if (!signal.aborted) {
        this.#logger.warn("Off-site backup copy failed", { backupId: id, reason });
        this.#deps.notifications.publish({
          kind: "backup-offsite-failed",
          severity: "warning",
          key: "offsite",
          params: { backup: id, target: label || "-", reason },
        });
      }
      throw error;
    }
  }
}
