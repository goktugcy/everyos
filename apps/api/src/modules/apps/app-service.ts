import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@everyos/agent-protocol";
import {
  CatalogError,
  inspectCompose,
  managedProject,
  parseCompose,
  prepareInstall,
  prepareInstallValues,
  recoverInputs,
  selectArchitecture,
  type InstallInputs,
} from "@everyos/catalogs";
import type { Database } from "@everyos/database";
import { detectAdapters } from "@everyos/widget-sdk";
import type { SecretBox } from "@everyos/security";
import {
  AI_AGENT_CATALOG_ID,
  type AppAction,
  type AppCatalogUpdate,
  type AppConfiguration,
  type AppDataSupport,
  type AppJobView,
  type CatalogApp,
  type InstalledAppView,
  type LocalizedText,
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
interface CatalogBaseline {
  hash: string | null;
  version: string | null;
}
interface AppMetadata {
  pendingConfig?: {
    sealedCompose: string;
    previousHash: string;
    provenance: CatalogApp["source"];
    /** Sealed {@link InstallInputs} (`app:<id>:pending-inputs:v1`), committed with the file. */
    inputs?: string;
    template?: CatalogApp;
    catalog?: CatalogBaseline;
  };
  /** Sealed {@link InstallInputs} (`app:<id>:inputs:v1`): what the running file was prepared from. */
  inputs?: string;
  /** The definition the app runs, so its settings can be changed without updating it. */
  template?: CatalogApp;
  /** The catalog definition the app runs; a different catalog hash means an update. */
  catalog?: CatalogBaseline;
  /** Installed before EveryOS kept inputs, and they could not be recovered exactly. */
  inputsUnavailable?: boolean;
  icon?: string | null;
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
/** A definition kept with the app: everything needed to prepare it again, no display extras. */
function storedTemplate(app: CatalogApp): CatalogApp {
  return { ...app, screenshots: [], description: {}, notes: {}, variants: {} };
}
/** What a catalog definition is, for noticing that it changed (catalog hashes are optional). */
function fingerprint(app: CatalogApp): string {
  return createHash("sha256")
    .update(app.compose)
    .update(JSON.stringify(app.variants ?? {}))
    .digest("hex");
}
const hostArch = (arch: string) => (arch === "x64" ? "amd64" : arch === "aarch64" ? "arm64" : arch);
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
    await this.#adoptLegacy(actor);
    const catalogApps = new Map(
      this.#catalogs
        .apps()
        .map((app) => [JSON.stringify([app.source.catalogId, app.source.path]), app]),
    );
    return this.#db
      .all<AppRow>("SELECT * FROM installed_apps WHERE removed = 0 ORDER BY installed_at DESC")
      .map((row) => {
        const members = list.containers.filter((container) => container.project === row.project);
        const metadata = JSON.parse(row.metadata) as AppMetadata;
        const provenance = JSON.parse(row.provenance) as CatalogApp["source"];
        const latest = this.#db.get<{ id: string }>(
          "SELECT id FROM app_jobs WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          row.id,
        );
        return {
          id: row.id,
          name: JSON.parse(row.name) as CatalogApp["name"],
          icon:
            metadata.icon ??
            catalogApps.get(JSON.stringify([provenance.catalogId, provenance.path]))?.icon ??
            null,
          project: row.project,
          provenance,
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
          configurable: Boolean(metadata.inputs && metadata.template),
          catalogUpdate: this.#catalogUpdate(row.id, metadata, provenance),
        };
      });
  }
  /**
   * A newer catalog definition, compared by fingerprint (catalog hashes are optional). Apps
   * installed before EveryOS kept one take the current one as their baseline.
   */
  #catalogUpdate(
    id: string,
    metadata: AppMetadata,
    provenance: CatalogApp["source"],
  ): AppCatalogUpdate | null {
    if (provenance.catalogId === AI_AGENT_CATALOG_ID) return null;
    const app = this.#catalogApp(provenance);
    if (!app) return null;
    const current = { hash: fingerprint(app), version: app.version };
    if (!metadata.catalog?.hash) {
      metadata.catalog = current;
      this.#db.run(
        "UPDATE installed_apps SET metadata = ? WHERE id = ?",
        JSON.stringify(metadata),
        id,
      );
      return null;
    }
    return current.hash === metadata.catalog.hash
      ? null
      : { version: current.version, installedVersion: metadata.catalog.version };
  }
  /** Installed apps with a newer catalog definition, for the notification center. */
  catalogUpdates(): Array<{ id: string; name: LocalizedText; version: string | null }> {
    return this.#db.all<AppRow>("SELECT * FROM installed_apps WHERE removed = 0").flatMap((row) => {
      const update = this.#catalogUpdate(
        row.id,
        JSON.parse(row.metadata) as AppMetadata,
        JSON.parse(row.provenance) as CatalogApp["source"],
      );
      return update
        ? [{ id: row.id, name: JSON.parse(row.name) as LocalizedText, version: update.version }]
        : [];
    });
  }
  /**
   * Apps installed before EveryOS kept their inputs: recovered once from the stored file with
   * the current catalog definition, and kept only when preparing it again reproduces that file.
   */
  async #adoptLegacy(actor: Actor): Promise<void> {
    const rows = this.#db
      .all<AppRow>("SELECT * FROM installed_apps WHERE removed = 0")
      .filter((row) => {
        const metadata = JSON.parse(row.metadata) as AppMetadata;
        const provenance = JSON.parse(row.provenance) as CatalogApp["source"];
        return (
          !metadata.inputs &&
          !metadata.inputsUnavailable &&
          !metadata.pendingConfig &&
          provenance.catalogId !== AI_AGENT_CATALOG_ID
        );
      });
    if (!rows.length) return;
    const system = await this.#agent.call("system.info", {}, actor).catch(() => null);
    if (!system) return;
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata) as AppMetadata;
      const found = this.#catalogTemplate(
        JSON.parse(row.provenance) as CatalogApp["source"],
        hostArch(system.arch),
      );
      // A catalog that is disabled or gone may come back; only a real attempt is final.
      if (!found) continue;
      const recovered = recoverInputs(
        found.app,
        row.id,
        this.#secrets.open(row.sealed_compose, `app:${row.id}:compose:v1`),
      );
      if (recovered) {
        metadata.inputs = this.#sealInputs(row.id, "inputs", recovered);
        metadata.template = storedTemplate(found.app);
        metadata.catalog = { hash: found.hash, version: found.app.version };
      } else metadata.inputsUnavailable = true;
      this.#db.run(
        "UPDATE installed_apps SET metadata = ? WHERE id = ?",
        JSON.stringify(metadata),
        row.id,
      );
    }
  }
  /** The catalog's current definition of an installed app. */
  #catalogApp(provenance: CatalogApp["source"]): CatalogApp | null {
    return this.#catalogs.appAt(provenance.catalogId, provenance.path);
  }
  /** That definition for this host's architecture, with the whole definition's fingerprint. */
  #catalogTemplate(
    provenance: CatalogApp["source"],
    arch: string,
  ): { app: CatalogApp; hash: string } | null {
    const app = this.#catalogApp(provenance);
    return app ? { app: selectArchitecture(app, arch), hash: fingerprint(app) } : null;
  }
  #sealInputs(id: string, kind: "inputs" | "pending-inputs", inputs: InstallInputs): string {
    return this.#secrets.seal(JSON.stringify(inputs), `app:${id}:${kind}:v1`);
  }
  #openInputs(id: string, sealed: string): InstallInputs {
    return JSON.parse(this.#secrets.open(sealed, `app:${id}:inputs:v1`)) as InstallInputs;
  }
  /** The settings form: the running definition, or the catalog's newer one with kept values. */
  async configuration(
    id: string,
    target: "current" | "update",
    actor: Actor,
  ): Promise<AppConfiguration> {
    const { template, inputs } = await this.#configurable(id, target, actor);
    return {
      target,
      version: template.version,
      variables: template.variables.map((entry) => {
        const stored = inputs.variables[entry.key];
        const hidden = entry.secret || entry.generated;
        return {
          ...entry,
          // Secrets never leave the server; they are kept unless replaced.
          default: hidden ? null : entry.default,
          value: hidden ? null : (stored ?? null),
          hasValue: stored !== undefined && stored !== "",
        };
      }),
      ports: template.ports,
      fixedPorts: inputs.ports.filter((port) =>
        template.ports.some(
          (entry) => entry.service === port.service && entry.index === port.index,
        ),
      ),
      risks: template.risks,
      images: template.images,
    };
  }
  async #configurable(id: string, target: "current" | "update", actor: Actor) {
    const row = this.#row(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Installed application not found");
    await this.#adoptLegacy(actor);
    const metadata = JSON.parse(this.#row(id)!.metadata) as AppMetadata;
    if (!metadata.inputs || !metadata.template)
      throw new ApiError(409, "CONFLICT", "This installation's settings cannot be changed", {
        details: { reason: "inputs-unavailable" },
      });
    let template = metadata.template;
    let baseline = metadata.catalog ?? null;
    if (target === "update") {
      const system = await this.#agent.call("system.info", {}, actor).catch((error: unknown) => {
        throw toApiError(error);
      });
      const current = this.#catalogTemplate(
        JSON.parse(row.provenance) as CatalogApp["source"],
        hostArch(system.arch),
      );
      if (!current) throw new ApiError(404, "NOT_FOUND", "The catalog no longer offers this app");
      template = current.app;
      baseline = { hash: current.hash, version: current.app.version };
    }
    return { row, metadata, template, baseline, inputs: this.#openInputs(id, metadata.inputs) };
  }
  /**
   * Changes settings or moves to the catalog's newer definition with the kept values. The new
   * file is deployed by an update job; a failed deployment restores the previous one.
   */
  async configure(
    id: string,
    input: {
      target: "current" | "update";
      variables: Record<string, string>;
      ports: { service: string; index: number; host: number }[];
      acknowledgeRisks: boolean;
    },
    actor: Actor,
  ): Promise<AppJobView> {
    this.#capacity(id);
    const { row, metadata, template, baseline, inputs } = await this.#configurable(
      id,
      input.target,
      actor,
    );
    const declared = new Map(template.variables.map((entry) => [entry.key, entry]));
    if (Object.keys(input.variables).some((key) => !declared.has(key)))
      throw new ApiError(422, "VALIDATION_FAILED", "Unknown setting");
    if (template.blockers.length)
      throw new ApiError(422, "VALIDATION_FAILED", "Unsupported Compose template", {
        details: { reason: "unsupported-compose", blockers: template.blockers },
      });
    const risky = template.risks.some(
      (risk) => risk !== "unpinned-image" && risk !== "default-secret",
    );
    if (template.risks.length && !input.acknowledgeRisks)
      throw new ApiError(422, "VALIDATION_FAILED", "Risk acknowledgement required", {
        details: { reason: "risk-acknowledgement" },
      });
    if (risky && (actor.kind !== "user" || actor.role !== "admin"))
      throw new ApiError(403, "FORBIDDEN", "Administrator risk approval required");
    const variables: Record<string, string> = {};
    for (const entry of template.variables) {
      const given = input.variables[entry.key];
      const hidden = entry.secret || entry.generated;
      // A blank secret keeps the stored one; generated values are never regenerated.
      if (given !== undefined && !(hidden && given === "")) variables[entry.key] = given;
      else if (inputs.variables[entry.key] !== undefined)
        variables[entry.key] = inputs.variables[entry.key]!;
    }
    let prepared: { compose: string; variables: Record<string, string> };
    try {
      prepared = prepareInstallValues(
        template,
        id,
        { variables, ports: input.ports },
        inputs.defaults ?? undefined,
      );
    } catch (error) {
      throw new ApiError(422, "VALIDATION_FAILED", "Invalid installation inputs", {
        details: { reason: error instanceof CatalogError ? error.reason : "invalid-input" },
      });
    }
    const previous = this.#secrets.open(row.sealed_compose, `app:${id}:compose:v1`);
    if (prepared.compose === previous && input.target === "current")
      throw new ApiError(409, "CONFLICT", "Nothing changed", { details: { reason: "unchanged" } });
    const inspection = await this.#agent
      .call("apps.inspect", { id }, actor)
      .catch((error: unknown) => {
        throw toApiError(error);
      });
    if (inspection.busy) throw new ApiError(409, "CONFLICT", "Application operation in progress");
    this.#capacity(id);
    metadata.pendingConfig = {
      sealedCompose: this.#secrets.seal(prepared.compose, `app:${id}:pending-compose:v1`),
      previousHash: createHash("sha256").update(previous).digest("hex"),
      provenance: template.source,
      inputs: this.#sealInputs(id, "pending-inputs", {
        variables: prepared.variables,
        ports: input.ports,
        defaults: inputs.defaults,
      }),
      template: storedTemplate(template),
      ...(baseline ? { catalog: baseline } : {}),
    };
    this.#db.run(
      "UPDATE installed_apps SET metadata = ?, risk_override = ? WHERE id = ?",
      JSON.stringify(metadata),
      risky ? 1 : 0,
      id,
    );
    return this.#enqueue(id, "update", actor);
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
  /** Application jobs queued or deploying right now. */
  activeJobs(): number {
    return this.#running.size;
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
    const app = this.#catalogs.app(input.appId);
    if (!app) throw new ApiError(404, "NOT_FOUND", "Catalog application not found");
    if (app.source.ref !== input.snapshot)
      throw new ApiError(409, "CONFLICT", "Catalog snapshot changed");
    return this.#installApp(app, input, actor);
  }
  /** Repository-owned templates; no HTTP route accepts a template from the caller. */
  installBuiltin(app: CatalogApp, actor: Actor): Promise<AppJobView> {
    return this.#installApp(app, { variables: {}, ports: [], acknowledgeRisks: true }, actor);
  }
  /** `allowedRisks` are risks the caller's template deliberately has (e.g. GPU devices). */
  async configureBuiltin(
    id: string,
    template: CatalogApp,
    actor: Actor,
    allowedRisks: readonly string[] = [],
  ): Promise<AppJobView> {
    this.#capacity(id);
    const row = this.#row(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Installed application not found");
    const provenance = JSON.parse(row.provenance) as CatalogApp["source"];
    if (
      provenance.catalogId !== template.source.catalogId ||
      provenance.path !== template.source.path
    )
      throw new ApiError(403, "FORBIDDEN", "Application template does not match");
    // Built-in templates carry freshly generated keys, which inspection classifies as literals.
    const risks = template.risks.filter((risk) => risk !== "default-secret");
    if (template.blockers.length || risks.some((risk) => !allowedRisks.includes(risk)))
      throw new ApiError(422, "VALIDATION_FAILED", "Unsafe built-in template");
    if (risks.length && (actor.kind !== "user" || actor.role !== "admin"))
      throw new ApiError(403, "FORBIDDEN", "Administrator risk approval required");
    const inspection = await this.#agent
      .call("apps.inspect", { id }, actor)
      .catch((error: unknown) => {
        throw toApiError(error);
      });
    if (inspection.busy) throw new ApiError(409, "CONFLICT", "Application operation in progress");
    const compose = prepareInstall(template, id, { variables: {}, ports: [] });
    this.#capacity(id);
    const metadata = JSON.parse(row.metadata) as AppMetadata;
    metadata.pendingConfig = {
      sealedCompose: this.#secrets.seal(compose, `app:${id}:pending-compose:v1`),
      previousHash: createHash("sha256")
        .update(this.#secrets.open(row.sealed_compose, `app:${id}:compose:v1`))
        .digest("hex"),
      provenance: template.source,
    };
    // The agent re-checks the administrator approval for a risky update.
    this.#db.run(
      "UPDATE installed_apps SET metadata = ?, risk_override = ? WHERE id = ?",
      JSON.stringify(metadata),
      risks.length ? 1 : row.risk_override,
      id,
    );
    return this.#enqueue(id, "update", actor);
  }
  async #installApp(
    template: CatalogApp,
    input: {
      variables: Record<string, string>;
      ports: { service: string; index: number; host: number }[];
      acknowledgeRisks: boolean;
      dataFrom?: string | undefined;
      confirmDataFrom?: string | undefined;
    },
    actor: Actor,
  ): Promise<AppJobView> {
    this.#capacity();
    let app = template;
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
    let compose: string, resolved: Record<string, string>;
    const defaults = await this.#agent.call("apps.defaults", {}, actor).catch((error: unknown) => {
      throw toApiError(error);
    });
    try {
      ({ compose, variables: resolved } = prepareInstallValues(app, id, input, defaults));
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
        icon: app.icon ? `/api/catalogs/apps/${encodeURIComponent(app.id)}/icon` : null,
        web: app.web ?? { path: "/", scheme: "http" },
        services: Object.keys(parseCompose(compose).services as Record<string, unknown>),
        dataCopyEligible:
          app.mounts.some((mount) => /^\$\{?APP_DATA_DIR\}?\//.test(mount.source ?? "")) &&
          app.mounts.every(
            (mount) =>
              mount.kind === "bind" &&
              (/^\$\{?APP_DATA_DIR\}?\//.test(mount.source ?? "") ||
                (mount.readOnly &&
                  /^\{\{otuken\.configDir\}\}\/config[0-9]{1,2}$/.test(mount.source ?? ""))),
          ),
        ...(input.dataFrom ? { dataFrom: input.dataFrom } : {}),
        inputs: this.#sealInputs(id, "inputs", {
          variables: resolved,
          ports: input.ports,
          defaults,
        }),
        template: storedTemplate(app),
        catalog: { hash: fingerprint(template), version: template.version },
      } satisfies AppMetadata),
    );
    return this.#enqueue(id, "install", actor);
  }
  async control(
    id: string,
    action: Exclude<AppAction, "install">,
    actor: Actor,
  ): Promise<AppJobView> {
    this.#capacity(id);
    let app = this.#row(id);
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
    if (
      (JSON.parse(app.metadata) as AppMetadata).pendingConfig &&
      app.last_error === "interrupted"
    ) {
      await this.reconcile(id, actor);
      app = this.#row(id)!;
    }
    if (action === "retry" && (JSON.parse(app.metadata) as AppMetadata).pendingConfig)
      action = "update";
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
        if (run.ok && run.action === "update" && metadata.pendingConfig)
          this.#commitConfig(row.id, metadata);
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
  #commitConfig(id: string, metadata: AppMetadata): void {
    const pending = metadata.pendingConfig;
    if (!pending) return;
    if (pending.inputs)
      metadata.inputs = this.#secrets.seal(
        this.#secrets.open(pending.inputs, `app:${id}:pending-inputs:v1`),
        `app:${id}:inputs:v1`,
      );
    if (pending.template) metadata.template = pending.template;
    if (pending.catalog) metadata.catalog = pending.catalog;
    this.#db.run(
      "UPDATE installed_apps SET sealed_compose = ?, provenance = ? WHERE id = ?",
      this.#secrets.seal(
        this.#secrets.open(pending.sealedCompose, `app:${id}:pending-compose:v1`),
        `app:${id}:compose:v1`,
      ),
      JSON.stringify(pending.provenance),
      id,
    );
    delete metadata.pendingConfig;
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
      const metadata = JSON.parse(app.metadata) as AppMetadata;
      const pending = job.action === "update" ? metadata.pendingConfig : undefined;
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
          compose: this.#secrets.open(
            pending?.sealedCompose ?? app.sealed_compose,
            pending ? `app:${app.id}:pending-compose:v1` : `app:${app.id}:compose:v1`,
          ),
          ...(pending ? { previousComposeHash: pending.previousHash } : {}),
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
      if (!this.#stopped && ok && (pending || result.images?.length)) {
        if (result.images?.length) metadata.images = result.images;
        if (pending) this.#commitConfig(app.id, metadata);
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
