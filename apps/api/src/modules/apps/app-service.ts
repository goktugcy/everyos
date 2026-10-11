import { randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import {
  CatalogError,
  inspectCompose,
  managedProject,
  parseCompose,
  prepareInstall,
  selectArchitecture,
} from "@everyos/catalogs";
import type { Database } from "@everyos/database";
import { detectAdapters } from "@everyos/widget-sdk";
import type { SecretBox } from "@everyos/security";
import type {
  AppAction,
  AppDataSupport,
  AppJobView,
  CatalogApp,
  InstalledAppView,
  LocalizedText,
} from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { CatalogService } from "../catalogs/catalog-service.ts";
import { toApiError } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";

interface AppRow {
  id: string;
  name: string;
  project: string;
  provenance: string;
  sealed_compose: string;
  risk_override: number;
  source: "host" | "simulated";
  last_error: string | null;
  installed_at: number;
  removed: number;
  metadata: string;
}
interface AppMetadata {
  web?: CatalogApp["web"];
  images?: InstalledAppView["images"];
  dataCopyEligible?: boolean;
  dataFrom?: string;
  services?: string[];
}
/** A finished app job, as reported to the notification center. */
export interface FinishedJob {
  appId: string;
  name: LocalizedText;
  action: AppAction;
  ok: boolean;
  error: string | null;
  rollback: AppJobView["rollback"];
}
interface JobRow {
  id: string;
  app_id: string;
  action: AppAction;
  stage: AppJobView["stage"];
  error: string | null;
  rollback: AppJobView["rollback"];
  created_at: number;
  updated_at: number;
}
export class AppService {
  readonly #db: Database;
  readonly #agent: AgentGateway;
  readonly #secrets: SecretBox;
  readonly #catalogs: CatalogService;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #running = new Map<string, AbortController>();
  readonly #listeners = new Set<() => void>();
  readonly #onJobFinished: ((job: FinishedJob) => void) | undefined;
  #stopped = false;

  constructor(deps: {
    db: Database;
    agent: AgentGateway;
    secrets: SecretBox;
    catalogs: CatalogService;
    audit: AuditLog;
    now: () => number;
    /** Called once per finished job (notifications). */
    onJobFinished?: (job: FinishedJob) => void;
  }) {
    this.#onJobFinished = deps.onJobFinished;
    this.#db = deps.db;
    this.#agent = deps.agent;
    this.#secrets = deps.secrets;
    this.#catalogs = deps.catalogs;
    this.#audit = deps.audit;
    this.#now = deps.now;
    // A process restart cannot prove whether the agent finished an interrupted mutation.
    this.#db.run(
      "UPDATE installed_apps SET last_error = 'interrupted' WHERE id IN (SELECT app_id FROM app_jobs WHERE stage IN ('queued', 'deploying'))",
    );
    this.#db.run(
      "UPDATE app_jobs SET stage = 'failed', error = 'interrupted', rollback = 'unknown', updated_at = ? WHERE stage IN ('queued', 'deploying')",
      this.#now(),
    );
  }
  stop(): void {
    this.#stopped = true;
    for (const controller of this.#running.values()) controller.abort();
    for (const listener of this.#listeners) listener();
  }
  owns(project: string): boolean {
    return (
      this.#db.get<{ id: string }>(
        "SELECT id FROM installed_apps WHERE project = ? AND removed = 0",
        project,
      ) !== undefined
    );
  }
  /** Installed (not removed) apps with their Compose project, for widgets. */
  managedProjects(): Array<{ id: string; name: LocalizedText; project: string }> {
    return this.#db
      .all<{ id: string; name: string; project: string }>(
        "SELECT id, name, project FROM installed_apps WHERE removed = 0 ORDER BY installed_at",
      )
      .map((row) => {
        let name: LocalizedText = {};
        try {
          name = JSON.parse(row.name) as LocalizedText;
        } catch {
          // Keep an empty name rather than failing the widget.
        }
        return { id: row.id, name, project: row.project };
      });
  }

  exists(id: string): boolean {
    return (
      this.#db.get<{ id: string }>(
        "SELECT id FROM installed_apps WHERE id = ? AND removed = 0",
        id,
      ) !== undefined
    );
  }

  /**
   * Whether an installed app's data can be backed up from its EveryOS app data
   * directory (every mount is a bind under it), or null when it is not installed.
   */
  dataSupport(id: string): AppDataSupport | null {
    const row = this.#row(id);
    if (!row) return null;
    if ((JSON.parse(row.metadata) as AppMetadata).dataCopyEligible === true) return "supported";
    try {
      const compose = this.#secrets.open(row.sealed_compose, `app:${id}:compose:v1`);
      return inspectCompose(compose).mounts.length === 0 ? "none" : "unsupported";
    } catch {
      return "unsupported";
    }
  }

  #row(id: string): AppRow | null {
    return (
      this.#db.get<AppRow>("SELECT * FROM installed_apps WHERE id = ? AND removed = 0", id) ?? null
    );
  }
  async list(actor: Actor): Promise<InstalledAppView[]> {
    const list = await this.#agent
      .call("docker.containers.list", {}, actor)
      .catch((error: unknown) => {
        throw toApiError(error);
      });
    return this.#db
      .all<AppRow>("SELECT * FROM installed_apps WHERE removed = 0 ORDER BY installed_at DESC")
      .map((row) => {
        const members = list.containers.filter((container) => container.project === row.project);
        const metadata = JSON.parse(row.metadata) as AppMetadata;
        const latest = this.#db.get<{ id: string }>(
          "SELECT id FROM app_jobs WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          row.id,
        );
        return {
          id: row.id,
          name: JSON.parse(row.name) as CatalogApp["name"],
          project: row.project,
          provenance: JSON.parse(row.provenance) as CatalogApp["source"],
          source: list.source,
          state: this.#running.has(row.id)
            ? "busy"
            : !members.length
              ? "missing"
              : members.some((container) => container.state === "running")
                ? members.some(
                    (container) =>
                      container.state !== "running" ||
                      container.health === "unhealthy" ||
                      container.health === "starting",
                  ) ||
                  (metadata.services &&
                    metadata.services.some(
                      (service) => !members.some((container) => container.service === service),
                    ))
                  ? "degraded"
                  : "running"
                : "stopped",
          lastError: row.last_error,
          installedAt: row.installed_at,
          images: metadata.images ?? [],
          web: metadata.web ?? { path: "/", scheme: "http" },
          ports: members.flatMap((container) =>
            container.ports
              .filter(
                (port) =>
                  port.publicPort !== null &&
                  port.type === "tcp" &&
                  container.service === metadata.web?.service &&
                  port.privatePort === metadata.web?.port,
              )
              .map((port) => ({ port: port.publicPort!, hostIp: port.ip })),
          ),
          lastJob: latest ? this.job(latest.id) : null,
          dataCopyEligible:
            metadata.dataCopyEligible === true &&
            members.every((container) => container.state !== "running"),
          widgetAdapters: detectAdapters(
            (metadata.images ?? [])
              .map((image) => image.reference)
              .concat(members.map((c) => c.image)),
          ),
        };
      });
  }
  job(id: string): AppJobView | null {
    const row = this.#db.get<JobRow>("SELECT * FROM app_jobs WHERE id = ?", id);
    return row
      ? {
          id: row.id,
          appId: row.app_id,
          action: row.action,
          stage: row.stage,
          error: row.error,
          rollback: row.rollback,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }
  #capacity(id?: string): void {
    if (this.#stopped || this.#running.size >= 2 || (id && this.#running.has(id)))
      throw new ApiError(409, "CONFLICT", "Application operation in progress");
  }
  async install(
    input: {
      appId: string;
      snapshot: string;
      variables: Record<string, string>;
      ports: { service: string; index: number; host: number }[];
      acknowledgeRisks: boolean;
      dataFrom?: string | undefined;
      confirmDataFrom?: string | undefined;
    },
    actor: Actor,
  ): Promise<AppJobView> {
    this.#capacity();
    let app = this.#catalogs.app(input.appId);
    if (!app) throw new ApiError(404, "NOT_FOUND", "Catalog application not found");
    if (app.source.ref !== input.snapshot)
      throw new ApiError(409, "CONFLICT", "Catalog snapshot changed");
    const system = await this.#agent.call("system.info", {}, actor).catch((error: unknown) => {
      throw toApiError(error);
    });
    const arch =
      system.arch === "x64" ? "amd64" : system.arch === "aarch64" ? "arm64" : system.arch;
    app = selectArchitecture(app, arch);
    if (app.blockers.length)
      throw new ApiError(422, "VALIDATION_FAILED", "Unsupported Compose template", {
        details: { reason: "unsupported-compose", blockers: app.blockers },
      });
    const risky = app.risks.some((risk) => risk !== "unpinned-image" && risk !== "default-secret");
    if (app.risks.length && !input.acknowledgeRisks)
      throw new ApiError(422, "VALIDATION_FAILED", "Risk acknowledgement required", {
        details: { reason: "risk-acknowledgement" },
      });
    if (risky && (actor.kind !== "user" || actor.role !== "admin"))
      throw new ApiError(403, "FORBIDDEN", "Administrator risk approval required");
    if (app.architectures.length && !app.architectures.includes(arch))
      throw new ApiError(422, "VALIDATION_FAILED", "Incompatible architecture", {
        details: { reason: "architecture", arch },
      });
    const id = randomUUID();
    if (input.dataFrom) {
      if (input.confirmDataFrom !== input.dataFrom)
        throw new ApiError(422, "VALIDATION_FAILED", "Data source confirmation required");
      const source = this.#row(input.dataFrom);
      if (!source || (JSON.parse(source.metadata) as AppMetadata).dataCopyEligible !== true)
        throw new ApiError(
          422,
          "VALIDATION_FAILED",
          "Source does not have transferable owned data",
        );
      const containers = await this.#agent.call("docker.containers.list", {}, actor);
      if (
        containers.containers.some(
          (container) => container.project === source.project && container.state === "running",
        )
      )
        throw new ApiError(409, "CONFLICT", "Stop the source application before copying data");
    }
    let compose: string;
    try {
      compose = prepareInstall(app, id, input);
    } catch (error) {
      throw new ApiError(422, "VALIDATION_FAILED", "Invalid installation inputs", {
        details: { reason: error instanceof CatalogError ? error.reason : "invalid-input" },
      });
    }
    this.#capacity();
    this.#db.run(
      "INSERT INTO installed_apps(id, name, project, provenance, sealed_compose, risk_override, source, installed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      JSON.stringify(app.name),
      managedProject(id),
      JSON.stringify(app.source),
      this.#secrets.seal(compose, `app:${id}:compose:v1`),
      risky ? 1 : 0,
      system.source,
      this.#now(),
      JSON.stringify({
        web: app.web ?? { path: "/", scheme: "http" },
        services: Object.keys(parseCompose(compose).services as Record<string, unknown>),
        dataCopyEligible:
          app.mounts.length > 0 &&
          app.mounts.every(
            (mount) => mount.kind === "bind" && /^\$\{?APP_DATA_DIR\}?\//.test(mount.source ?? ""),
          ),
        ...(input.dataFrom ? { dataFrom: input.dataFrom } : {}),
      }),
    );
    return this.#enqueue(id, "install", actor);
  }
  async control(
    id: string,
    action: Exclude<AppAction, "install">,
    actor: Actor,
  ): Promise<AppJobView> {
    this.#capacity(id);
    const app = this.#row(id);
    if (!app) throw new ApiError(404, "NOT_FOUND", "Installed application not found");
    if (
      (action === "update" || action === "retry") &&
      app.risk_override &&
      (actor.kind !== "user" || actor.role !== "admin")
    )
      throw new ApiError(403, "FORBIDDEN", "Administrator risk approval required");
    const inspection = await this.#agent
      .call("apps.inspect", { id }, actor)
      .catch((error: unknown) => {
        throw toApiError(error);
      });
    if (inspection.busy)
      throw new ApiError(409, "CONFLICT", "The agent is still executing an operation");
    this.#capacity(id);
    return this.#enqueue(id, action, actor);
  }
  async reconcile(id: string, actor: Actor) {
    const row = this.#row(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Installed application not found");
    const inspection = await this.#agent
      .call("apps.inspect", { id }, actor)
      .catch((error: unknown) => {
        throw toApiError(error);
      });
    const latest = this.#db.get<{ id: string }>(
      "SELECT id FROM app_jobs WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      id,
    );
    const job = latest ? this.job(latest.id) : null;
    const run = inspection.lastRun;
    if (!inspection.busy && job?.error === "interrupted" && run?.jobId === job.id) {
      this.#db.transaction(() => {
        this.#db.run(
          "UPDATE app_jobs SET stage = ?, error = ?, rollback = ?, updated_at = ? WHERE id = ?",
          run.ok ? "succeeded" : "failed",
          run.ok ? null : "compose-failed",
          run.rollback,
          this.#now(),
          job.id,
        );
        const metadata = JSON.parse(row.metadata) as AppMetadata;
        if (run.ok && run.images.length) metadata.images = run.images;
        this.#db.run(
          "UPDATE installed_apps SET last_error = ?, removed = ?, metadata = ? WHERE id = ?",
          run.ok ? null : "compose-failed",
          run.ok && run.action === "remove" ? 1 : 0,
          JSON.stringify(metadata),
          id,
        );
      });
    }
    this.#audit.record({
      action: "apps.reconcile",
      target: id,
      outcome: "success",
      ...(actor.kind === "user"
        ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
        : {}),
      details: { ownership: inspection.ownership, busy: inspection.busy },
    });
    return {
      ownership: inspection.ownership,
      busy: inspection.busy,
      job: job ? this.job(job.id) : null,
    };
  }
  #enqueue(id: string, action: AppAction, actor: Actor): AppJobView {
    const jobId = randomUUID();
    const now = this.#now();
    this.#db.run(
      "INSERT INTO app_jobs(id, app_id, action, stage, rollback, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'not-needed', ?, ?)",
      jobId,
      id,
      action,
      now,
      now,
    );
    const controller = new AbortController();
    this.#running.set(id, controller);
    const job = this.job(jobId);
    if (!job) throw new Error("Job insertion failed");
    // The mutation outlives the initiating HTTP request; progress uses a read-only stream.
    void this.#run(job, actor, controller.signal).finally(() => {
      this.#running.delete(id);
      for (const listener of this.#listeners) listener();
    });
    return job;
  }
  async #run(job: AppJobView, actor: Actor, signal: AbortSignal): Promise<void> {
    let ok = false;
    let error: string | null = null;
    let rollback: AppJobView["rollback"] = "not-needed";
    try {
      const app = this.#row(job.appId);
      if (!app) throw new Error("App record missing");
      this.#db.run(
        "UPDATE app_jobs SET stage = 'deploying', updated_at = ? WHERE id = ?",
        this.#now(),
        job.id,
      );
      for (const listener of this.#listeners) listener();
      const result = await this.#agent.call(
        "apps.run",
        {
          id: app.id,
          action: job.action,
          compose: this.#secrets.open(app.sealed_compose, `app:${app.id}:compose:v1`),
          riskOverride: app.risk_override === 1,
          jobId: job.id,
          ...((JSON.parse(app.metadata) as AppMetadata).dataFrom
            ? { dataFrom: (JSON.parse(app.metadata) as AppMetadata).dataFrom! }
            : {}),
        },
        actor,
        { signal },
      );
      ok = result.ok;
      rollback = result.rollback;
      if (!ok) error = "compose-failed";
      if (!this.#stopped)
        this.#db.run("UPDATE installed_apps SET source = ? WHERE id = ?", result.source, app.id);
      if (!this.#stopped && ok && result.images?.length) {
        const metadata = JSON.parse(app.metadata) as AppMetadata;
        metadata.images = result.images;
        this.#db.run(
          "UPDATE installed_apps SET metadata = ? WHERE id = ?",
          JSON.stringify(metadata),
          app.id,
        );
      }
    } catch (caught) {
      error = toApiError(caught).code;
      rollback = ["install", "retry", "update"].includes(job.action) ? "unknown" : "not-needed";
    }
    if (this.#stopped) return;
    this.#db.transaction(() => {
      this.#db.run(
        "UPDATE app_jobs SET stage = ?, error = ?, rollback = ?, updated_at = ? WHERE id = ?",
        ok ? "succeeded" : "failed",
        error,
        rollback,
        this.#now(),
        job.id,
      );
      this.#db.run(
        "UPDATE installed_apps SET last_error = ?, removed = ? WHERE id = ?",
        error,
        ok && job.action === "remove" ? 1 : 0,
        job.appId,
      );
      this.#audit.record({
        action: `apps.${job.action}`,
        target: job.appId,
        outcome: ok ? "success" : "failure",
        ...(actor.kind === "user"
          ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
          : {}),
        details: { jobId: job.id, rollback, ...(error ? { reason: error } : {}) },
      });
    });
    // Removed apps keep their row (marked removed), so the name is still known.
    const row = this.#db.get<{ name: string }>(
      "SELECT name FROM installed_apps WHERE id = ?",
      job.appId,
    );
    let name: LocalizedText = {};
    try {
      name = JSON.parse(row?.name ?? "{}") as LocalizedText;
    } catch {
      // The notification falls back to the app id.
    }
    this.#onJobFinished?.({ appId: job.appId, name, action: job.action, ok, error, rollback });
  }
  async *events(id: string, signal: AbortSignal): AsyncGenerator<AppJobView> {
    let wake: (() => void) | null = null;
    let revision = 0;
    const listener = () => {
      revision++;
      wake?.();
    };
    this.#listeners.add(listener);
    signal.addEventListener("abort", listener);
    try {
      while (!signal.aborted && !this.#stopped) {
        const job = this.job(id);
        if (!job) return;
        const observed = revision;
        yield job;
        if (job.stage === "succeeded" || job.stage === "failed") return;
        if (observed !== revision) continue;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (signal.aborted || this.#stopped) resolve();
        });
      }
    } finally {
      this.#listeners.delete(listener);
      signal.removeEventListener("abort", listener);
    }
  }
}
