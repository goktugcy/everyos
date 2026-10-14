import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  OperationError,
  type OperationContext,
  type OperationParams,
  type OperationResult,
} from "@everyos/agent-protocol";
import { inspectCompose, object, parseCompose } from "@everyos/catalogs/compose";
import { DockerError, type DockerApi } from "@everyos/system";
import { stringify } from "yaml";
import type { AppImage } from "@everyos/shared";
import { aiNetworkMembers, applyAiNetwork } from "./ai-network.ts";
import type { SecretBox } from "@everyos/security";
import { copyManagedData } from "./managed-data.ts";
import { materializeConfigs } from "./managed-configs.ts";
import { pinAssignedPorts, retainAssignedPorts } from "./app-ports.ts";

type RunParams = OperationParams<"apps.run">;
type RunResult = OperationResult<"apps.run">;
const PLACEHOLDER = "{{otuken.appData}}";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class ManagedAppManager {
  readonly #docker: DockerApi;
  readonly #root: string;
  readonly #protected: (name: string) => boolean;
  readonly #busy = new Set<string>();
  readonly #secrets: SecretBox;
  constructor(options: {
    docker: DockerApi;
    root: string;
    isProtected: (name: string) => boolean;
    secrets: SecretBox;
  }) {
    this.#docker = options.docker;
    this.#root = options.root;
    this.#protected = options.isProtected;
    this.#secrets = options.secrets;
  }
  async #write(path: string, value: string): Promise<void> {
    await writeFile(`${path}.tmp`, value, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async withProjectLock<T>(project: string | null, run: () => Promise<T>): Promise<T> {
    if (!project || !/^otk-[a-f0-9]{32}$/.test(project)) return run();
    const release = this.lockProject(project);
    try {
      return await run();
    } finally {
      release();
    }
  }
  /** Marks a managed project busy until the returned function is called. */
  lockProject(project: string): () => void {
    const id = project.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    if (this.#busy.has(id))
      throw new OperationError("busy", "Managed application operation in progress");
    this.#busy.add(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#busy.delete(id);
    };
  }
  /** Directory holding every managed app (private to the agent). */
  get root(): string {
    return this.#root;
  }
  async inspect(id: string): Promise<OperationResult<"apps.inspect">> {
    let ownership: OperationResult<"apps.inspect">["ownership"] = "missing";
    let lastRun: OperationResult<"apps.inspect">["lastRun"] = null;
    try {
      await this.#directory(this.#root, false);
      const appDir = join(this.#root, id);
      const info = await lstat(appDir).catch(() => null);
      if (info) {
        await this.#directory(appDir, false);
        const marker = object(
          JSON.parse(await readFile(join(appDir, "ownership.json"), "utf8").catch(() => "{}")),
        );
        if (marker.id === id && marker.project === `otk-${id.replaceAll("-", "")}`)
          ownership =
            marker.removed === true
              ? "removed"
              : marker.phase === "deployed"
                ? "deployed"
                : "prepared";
        else
          ownership = await lstat(join(this.#root, `.intent-${id}`))
            .then(() => "prepared" as const)
            .catch(() => "conflict" as const);
        const run = await readFile(join(appDir, "last-run.json"), "utf8").catch(() => null);
        if (run) lastRun = JSON.parse(run) as NonNullable<typeof lastRun>;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") ownership = "conflict";
    }
    return { source: this.#docker.source, busy: this.#busy.has(id), ownership, lastRun };
  }
  /**
   * The verified directories of an owned, not removed app (for backups). The
   * caller holds `withProjectLock` while it reads or replaces the data.
   */
  async ownedApp(id: string): Promise<{ project: string; appDir: string; dataDir: string }> {
    const project = `otk-${id.replaceAll("-", "")}`;
    const appDir = join(this.#root, id);
    try {
      await this.#directory(this.#root, false);
      await this.#directory(appDir, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new OperationError("not_found", "Managed application not found");
      throw error;
    }
    const marker = object(
      JSON.parse(await readFile(join(appDir, "ownership.json"), "utf8").catch(() => "{}")),
    );
    if (marker.id !== id || marker.project !== project || marker.removed === true)
      throw new OperationError("not_found", "Managed application not found");
    return { project, appDir, dataDir: join(appDir, "data") };
  }
  /** True while any container of the project runs. */
  async projectRunning(project: string): Promise<boolean> {
    return (await this.#docker.listContainers()).some(
      (entry) => entry.project === project && entry.state === "running",
    );
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
    const copying =
      params.dataFrom && ["install", "retry"].includes(params.action) ? params.dataFrom : null;
    if (copying && (copying === id || this.#busy.has(copying))) {
      this.#busy.delete(id);
      throw new OperationError("busy", "Source application operation in progress");
    }
    if (copying) this.#busy.add(copying);
    try {
      return await this.#run(params, context);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError("failed", "Managed application operation failed");
    } finally {
      this.#busy.delete(id);
      if (copying) this.#busy.delete(copying);
    }
  }
  async #run(
    { id, action, compose, riskOverride, jobId, dataFrom, previousComposeHash }: RunParams,
    { actor, signal, logger }: OperationContext,
  ): Promise<RunResult> {
    const project = `otk-${id.replaceAll("-", "")}`;
    const appDir = join(this.#root, id);
    const dataDir = join(appDir, "data");
    const doc = parseCompose(compose);
    const original = inspectCompose(compose);
    if (original.blockers.length || original.variables.length)
      throw new OperationError("invalid_params", "Unsupported or unresolved application template");
    // Validated before anything is created on the host.
    aiNetworkMembers(doc);
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
      ["install", "retry", "update"].includes(action) &&
      risks.length &&
      (!riskOverride || actor.kind !== "user" || actor.role !== "admin")
    )
      throw new OperationError("policy_denied", "Administrator risk approval required");
    await this.#directory(this.#root);
    const marker = join(appDir, "ownership.json");
    const intent = join(this.#root, `.intent-${id}`);
    if (action === "install") {
      if ((await this.#docker.listProjects()).some((entry) => entry.name === project))
        throw new OperationError("conflict", "Project already exists");
      // Exclusive directory creation prevents adopting anything already present on the host.
      if (
        await lstat(appDir)
          .then(() => true)
          .catch(() => false)
      )
        throw new OperationError("conflict", "Managed application already exists");
      await writeFile(intent, JSON.stringify({ id, project, composeHash: digest(compose) }), {
        flag: "wx",
        mode: 0o600,
      });
      await mkdir(appDir, { mode: 0o700 }).catch(() => {
        throw new OperationError("conflict", "Managed application already exists");
      });
      await writeFile(
        marker,
        JSON.stringify({ id, project, composeHash: digest(compose), phase: "prepared" }),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      await mkdir(dataDir, { mode: 0o777 });
      await chmod(dataDir, 0o777);
    } else {
      if (action === "retry") {
        const record = object(JSON.parse(await readFile(intent, "utf8").catch(() => "{}")));
        if (
          record.id === id &&
          record.project === project &&
          record.composeHash === digest(compose)
        ) {
          await mkdir(appDir, { mode: 0o700 }).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          });
          await this.#directory(appDir, false);
          if (
            !(await lstat(marker)
              .then(() => true)
              .catch(() => false))
          )
            await writeFile(marker, JSON.stringify({ ...record, phase: "prepared" }), {
              flag: "wx",
              mode: 0o600,
            });
          if (
            !(await lstat(dataDir)
              .then(() => true)
              .catch(() => false))
          ) {
            await mkdir(dataDir, { mode: 0o777 });
            await chmod(dataDir, 0o777);
          }
        }
      }
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
        record.composeHash !==
          (action === "update" && previousComposeHash ? previousComposeHash : digest(compose)) ||
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
    if (applyAiNetwork(actual) && action !== "remove")
      await this.#docker.ensureAiNetwork().catch((error: unknown) => {
        throw error instanceof DockerError && error.kind === "conflict"
          ? new OperationError("policy_denied", "A foreign Docker network named everyos-ai exists")
          : new OperationError("failed", "The AI network could not be prepared");
      });
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
        const missing: string[] = [];
        current = source;
        while (current !== dataDir && !(await lstat(current).catch(() => null))) {
          missing.push(current);
          current = dirname(current);
        }
        for (const directory of missing.reverse()) {
          await mkdir(directory, { mode: 0o777 });
          await chmod(directory, 0o777);
        }
      }
    }
    const input = stringify(actual, { lineWidth: 0 });
    let ok = false;
    let images: AppImage[] = [];
    const deployment = join(appDir, "deployment.box"),
      deploymentContext = `app:${id}:deployment:v1`;
    const saved = await readFile(deployment, "utf8").catch(() => null);
    const previous = saved ? this.#secrets.open(saved, deploymentContext) : null;
    if (action === "update" && !previous)
      throw new OperationError(
        "invalid_params",
        "Retry installation to establish a pinned deployment before updating",
      );
    let runningInput = previous ?? input;
    let attempted = false;
    try {
      if (dataFrom && (action === "install" || action === "retry")) {
        if (dataFrom === id)
          throw new OperationError("invalid_params", "Cannot copy from the same instance");
        const sourceDir = join(this.#root, dataFrom);
        await this.#directory(sourceDir, false);
        const record = object(
          JSON.parse(await readFile(join(sourceDir, "ownership.json"), "utf8")),
        );
        if (
          record.id !== dataFrom ||
          record.project !== `otk-${dataFrom.replaceAll("-", "")}` ||
          record.removed === true ||
          !record.composeHash
        )
          throw new OperationError("policy_denied", "Source application is not owned");
        if (
          (await this.#docker.listContainers()).some(
            (entry) => entry.project === record.project && entry.state === "running",
          )
        )
          throw new OperationError(
            "policy_denied",
            "Source application must be stopped before copying data",
          );
        const currentMarker = object(JSON.parse(await readFile(marker, "utf8")));
        if (currentMarker.dataCopied !== true) {
          await copyManagedData(join(sourceDir, "data"), dataDir, signal);
          await this.#write(marker, JSON.stringify({ ...currentMarker, dataCopied: true }));
        }
      }
      if (["install", "retry", "update"].includes(action)) {
        const resolved = await this.#docker.resolveImages(
          previous ? retainAssignedPorts(input, previous) : input,
          `linux/${process.arch === "x64" ? "amd64" : process.arch}`,
          action === "update",
          signal,
        );
        runningInput = resolved.compose;
        images = resolved.images;
      }
      attempted = true;
      let result = await this.#docker.runCompose(
        project,
        appDir,
        [],
        action === "install" || action === "retry" || action === "update"
          ? "up"
          : action === "remove"
            ? "down"
            : action,
        signal,
        await materializeConfigs(runningInput, id, this.#docker.source === "simulated"),
      );
      if (
        result.ok &&
        ["install", "retry", "update"].includes(action) &&
        inspectCompose(runningInput).ports.some((port) => port.host === null)
      ) {
        runningInput = pinAssignedPorts(runningInput, project, await this.#docker.listContainers());
        // Docker reassigns ephemeral bindings on restart until HostConfig is recreated.
        result = await this.#docker.runCompose(
          project,
          appDir,
          [],
          "up",
          signal,
          await materializeConfigs(runningInput, id, this.#docker.source === "simulated"),
        );
      }
      ok = result.ok;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      /* CLI output and exception messages may contain credentials. */
    }
    let rollback: RunResult["rollback"] = "not-needed";
    if (
      !ok &&
      attempted &&
      (action === "install" || action === "retry" || (action === "update" && previous))
    ) {
      try {
        const result = await this.#docker.runCompose(
          project,
          appDir,
          [],
          action === "update" ? "up" : "down",
          AbortSignal.timeout(60_000),
          await materializeConfigs(
            action === "update" ? (previous ?? input) : runningInput,
            id,
            this.#docker.source === "simulated",
          ),
        );
        rollback = result.ok ? "succeeded" : "failed";
      } catch {
        rollback = "failed";
      }
    }
    if (ok && ["install", "retry", "update"].includes(action)) {
      await this.#write(deployment, this.#secrets.seal(runningInput, deploymentContext));
      const record = object(JSON.parse(await readFile(marker, "utf8")));
      await this.#write(
        marker,
        JSON.stringify({ ...record, composeHash: digest(compose), phase: "deployed" }),
      );
    }
    if (ok && action === "remove")
      await writeFile(
        marker,
        JSON.stringify({ id, project, composeHash: digest(compose), removed: true }),
        { mode: 0o600 },
      );
    logger.info("Managed application operation finished", { id, action, ok, rollback });
    await this.#write(
      join(appDir, "last-run.json"),
      JSON.stringify({ jobId: jobId ?? null, action, ok, rollback, images }),
    );
    return { source: this.#docker.source, ok, rollback, images };
  }
}
