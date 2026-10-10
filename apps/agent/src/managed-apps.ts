import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  OperationError,
  type OperationContext,
  type OperationParams,
  type OperationResult,
} from "@otuken/agent-protocol";
import { inspectCompose, object, parseCompose } from "@otuken/catalogs/compose";
import type { DockerApi } from "@otuken/system";
import { stringify } from "yaml";

type RunParams = OperationParams<"apps.run">;
type RunResult = OperationResult<"apps.run">;
const PLACEHOLDER = "{{otuken.appData}}";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class ManagedAppManager {
  readonly #docker: DockerApi;
  readonly #root: string;
  readonly #protected: (name: string) => boolean;
  readonly #busy = new Set<string>();
  constructor(options: {
    docker: DockerApi;
    root: string;
    isProtected: (name: string) => boolean;
  }) {
    this.#docker = options.docker;
    this.#root = options.root;
    this.#protected = options.isProtected;
  }
  async #directory(path: string, create = true): Promise<void> {
    if (!isAbsolute(path) || normalize(path) !== path)
      throw new OperationError("invalid_params", "Invalid managed directory");
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    )
      throw new OperationError(
        "policy_denied",
        "Managed directory must be private and owned by the agent",
      );
  }
  async run(params: RunParams, context: OperationContext): Promise<RunResult> {
    const { id } = params;
    if (this.#busy.has(id) || this.#busy.size >= 2)
      throw new OperationError("busy", "Managed application operation in progress");
    this.#busy.add(id);
    try {
      return await this.#run(params, context);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError("failed", "Managed application operation failed");
    } finally {
      this.#busy.delete(id);
    }
  }
  async #run(
    { id, action, compose, riskOverride }: RunParams,
    { actor, signal, logger }: OperationContext,
  ): Promise<RunResult> {
    const project = `otk-${id.replaceAll("-", "")}`;
    const appDir = join(this.#root, id);
    const dataDir = join(appDir, "data");
    const doc = parseCompose(compose);
    const original = inspectCompose(compose);
    if (original.blockers.length || original.variables.length)
      throw new OperationError("invalid_params", "Unsupported or unresolved application template");
    const riskDoc = parseCompose(compose);
    for (const raw of Object.values(object(riskDoc.services))) {
      const service = object(raw);
      // Only the agent's own app-data token is exempt from arbitrary-host-path risk.
      for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
        const entry = object(volume);
        if (typeof entry.source === "string" && entry.source.startsWith(PLACEHOLDER))
          entry.source = entry.source.replace(PLACEHOLDER, "${APP_DATA_DIR}");
      }
      if (Array.isArray(service.volumes))
        service.volumes = service.volumes.map((volume: unknown) =>
          typeof volume === "string" ? volume.replace(PLACEHOLDER, "${APP_DATA_DIR}") : volume,
        );
    }
    const risks = inspectCompose(stringify(riskDoc)).risks.filter(
      (risk) => risk !== "unpinned-image" && risk !== "default-secret",
    );
    if (
      ["install", "update"].includes(action) &&
      risks.length &&
      (!riskOverride || actor.kind !== "user" || actor.role !== "admin")
    )
      throw new OperationError("policy_denied", "Administrator risk approval required");
    await this.#directory(this.#root);
    const marker = join(appDir, "ownership.json");
    if (action === "install") {
      if ((await this.#docker.listProjects()).some((entry) => entry.name === project))
        throw new OperationError("conflict", "Project already exists");
      // Exclusive directory creation prevents adopting anything already present on the host.
      await mkdir(appDir, { mode: 0o700 }).catch(() => {
        throw new OperationError("conflict", "Managed application already exists");
      });
      await writeFile(marker, JSON.stringify({ id, project, composeHash: digest(compose) }), {
        flag: "wx",
        mode: 0o600,
      });
      await mkdir(dataDir, { mode: 0o777 });
      await chmod(dataDir, 0o777);
    } else {
      await this.#directory(appDir);
      let ownership: unknown;
      try {
        ownership = JSON.parse(await readFile(marker, "utf8"));
      } catch {
        throw new OperationError("policy_denied", "Application ownership is not recorded");
      }
      const record = object(ownership);
      if (
        record.id !== id ||
        record.project !== project ||
        record.composeHash !== digest(compose) ||
        record.removed === true
      )
        throw new OperationError(
          "policy_denied",
          "Application ownership or configuration mismatch",
        );
    }
    if (
      action !== "start" &&
      (await this.#docker.listContainers()).some(
        (entry) => entry.project === project && (entry.protected || this.#protected(entry.name)),
      )
    )
      throw new OperationError(
        "policy_denied",
        "PROTECTED_CONTAINER: managed project contains a protected container",
      );
    const actual = JSON.parse(JSON.stringify(doc).replaceAll(PLACEHOLDER, dataDir)) as Record<
      string,
      unknown
    >;
    // Check every existing path component; app data may have been written by a container.
    for (const raw of Object.values(object(actual.services))) {
      const service = object(raw);
      for (const mount of Array.isArray(service.volumes) ? service.volumes : []) {
        const source = typeof mount === "string" ? mount.split(":")[0] : object(mount).source;
        if (typeof source !== "string" || !source.startsWith(dataDir)) continue;
        if (
          normalize(source) !== source ||
          !(source === dataDir || source.startsWith(`${dataDir}/`))
        )
          throw new OperationError("invalid_params", "Invalid application data path");
        let current = source;
        while (current.startsWith(dataDir)) {
          const info = await lstat(current).catch(() => null);
          if (info?.isSymbolicLink())
            throw new OperationError("policy_denied", "Application data path contains a symlink");
          if (current === dataDir) break;
          current = dirname(current);
        }
      }
    }
    const input = stringify(actual, { lineWidth: 0 });
    let ok = false;
    try {
      const result = await this.#docker.runCompose(
        project,
        appDir,
        [],
        action === "install" ? "up" : action === "remove" ? "down" : action,
        signal,
        input,
      );
      ok = result.ok;
    } catch {
      /* CLI output and exception messages may contain credentials. */
    }
    let rollback: RunResult["rollback"] = "not-needed";
    if (!ok && action === "install") {
      try {
        const result = await this.#docker.runCompose(
          project,
          appDir,
          [],
          "down",
          AbortSignal.timeout(60_000),
          input,
        );
        rollback = result.ok ? "succeeded" : "failed";
      } catch {
        rollback = "failed";
      }
    }
    if (ok && action === "remove")
      await writeFile(
        marker,
        JSON.stringify({ id, project, composeHash: digest(compose), removed: true }),
        { mode: 0o600 },
      );
    logger.info("Managed application operation finished", { id, action, ok, rollback });
    return { source: this.#docker.source, ok, rollback };
  }
}
