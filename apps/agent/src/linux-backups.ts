import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { findExecutable } from "@everyos/system";
import { OperationError, type OperationParams } from "@everyos/agent-protocol";
import type {
  LinuxBackupArchive,
  LinuxBackupCapability,
  LinuxBackupJob,
  LinuxBackupSelection,
} from "@everyos/shared";
import { runBorg, type BorgInvocation } from "./linux-backup-runner.ts";
import { backupMounts, backupMountSelection } from "./linux-backup-mounts.ts";

type Spec = OperationParams<"backups.linux.start">["spec"];
const SYSTEM_PATHS = [
  "/etc",
  "/usr",
  "/boot",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var/lib/dpkg",
  "/var/lib/apt",
  "/var/lib/rpm",
  "/var/lib/pacman",
  "/var/lib/systemd",
  "/var/lib/dbus",
];
const OMIT = ["/proc", "/sys", "/dev", "/run", "/tmp", "/var/tmp"];
const ARCHIVE = /^eos-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const under = (path: string, parent: string) =>
  path === parent || path.startsWith(parent === "/" ? "/" : parent + "/");
const targetId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 16);
function fail(message: string): never {
  throw new OperationError("policy_denied", message);
}
const safeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export interface LinuxBackupOptions {
  mode: "production" | "development";
  directories: string[];
  mountedDirectories?: () => Promise<string[]>;
  /** Tests may operate only on an explicit disposable source tree, never the developer's root. */
  fixture?: { root: string; binary: string };
  reserveBytes?: number;
  run?: (input: BorgInvocation) => ReturnType<typeof runBorg>;
  now?: () => number;
}

/** Only dedicated, marked repositories under root-configured destinations can be modified. */
export class LinuxBackups {
  readonly #options: LinuxBackupOptions;
  readonly #root: string;
  readonly #run: typeof runBorg;
  readonly #jobs = new Map<string, LinuxBackupJob>();
  #active: { job: LinuxBackupJob; controller: AbortController } | null = null;
  #binary: string | null = null;
  #version: string | null = null;
  #execution: Promise<void> | null = null;

  constructor(options: LinuxBackupOptions) {
    this.#options = options;
    this.#root = options.fixture ? resolve(options.fixture.root) : "/";
    this.#run = options.run ?? runBorg;
  }

  get source(): "host" | "simulated" {
    return this.#options.fixture ? "simulated" : "host";
  }
  #now() {
    return (this.#options.now ?? Date.now)();
  }
  async #directories() {
    return [
      ...new Set([
        ...this.#options.directories,
        ...(await (this.#options.mountedDirectories?.() ?? Promise.resolve([]))),
      ]),
    ];
  }

  async status(): Promise<LinuxBackupCapability> {
    let reason: LinuxBackupCapability["reason"] = "ready";
    if (!this.#options.fixture && this.#options.mode !== "production") reason = "development-mode";
    else if (!this.#options.fixture && process.platform !== "linux") reason = "linux-required";
    else if (!this.#options.fixture && process.getuid?.() !== 0) reason = "root-required";
    if (reason === "ready" && !this.#binary) {
      const binary =
        this.#options.fixture?.binary ?? (await findExecutable("borg", { refresh: true }));
      if (!binary) reason = "borg-missing";
      else {
        try {
          const version = await this.#run({
            binary,
            args: ["--version"],
            cwd: this.#root,
            state: this.#root,
            passphrase: "",
            timeoutMs: 10_000,
          });
          const match = /^borg (1)\.(\d+)\.(\d+)\s*$/.exec(version.output.trim());
          // 1.2.5 fixed archive authentication; Borg 2 has a different CLI and repository format.
          if (
            version.code !== 0 ||
            !match ||
            Number(match[2]) < 2 ||
            (Number(match[2]) === 2 && Number(match[3]) < 5)
          )
            reason = "borg-version";
          else {
            this.#binary = binary;
            this.#version = match[0];
          }
        } catch {
          reason = "borg-missing";
        }
      }
    }
    const targets = await Promise.all(
      (await this.#directories()).map(async (path) => {
        try {
          const info = await this.#secureDirectory(path);
          await access(path, constants.W_OK);
          const space = await statfs(path);
          return {
            id: targetId(path),
            path,
            device: await this.#device(info.dev),
            freeBytes: space.bavail * space.bsize,
            available: true,
          };
        } catch {
          return { id: targetId(path), path, device: "", freeBytes: null, available: false };
        }
      }),
    );
    return {
      source: this.source,
      available: reason === "ready",
      reason,
      version: this.#version,
      installationSupported:
        reason === "borg-missing" &&
        !this.#options.fixture &&
        Boolean(
          (
            await Promise.all(
              ["apt-get", "apt-cache", "dpkg-query"].map((name) =>
                findExecutable(name, { refresh: true }),
              ),
            )
          ).every(Boolean),
        ),
      targets,
      systemIncludes: SYSTEM_PATHS,
      alwaysExcluded: [...OMIT, ...targets.map((target) => target.path)],
    };
  }

  async #secureDirectory(path: string) {
    if (!path.startsWith("/") || resolve(path) !== path) fail("BACKUP_TARGET_INVALID");
    let current = path;
    for (;;) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("BACKUP_TARGET_INVALID");
      if (!this.#options.fixture && (info.uid !== 0 || (info.mode & 0o022) !== 0))
        fail("BACKUP_TARGET_INSECURE");
      if (this.#options.fixture || current === "/") break;
      current = dirname(current);
    }
    if ((await realpath(path)) !== path) fail("BACKUP_TARGET_INVALID");
    return lstat(path);
  }

  async #device(device: number): Promise<string> {
    if (!this.#options.fixture && process.platform === "linux") {
      for (const name of await readdir("/dev/disk/by-uuid").catch(() => [] as string[])) {
        if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) continue;
        try {
          if ((await stat(join("/dev/disk/by-uuid", name))).rdev === device)
            return "uuid:" + name.toLowerCase();
        } catch {
          /* A device may disappear while udev is refreshing its links. */
        }
      }
    }
    return String(device);
  }

  async #repository(spec: Spec, create: boolean) {
    const status = await this.status();
    if (!status.available) throw new OperationError("unsupported", status.reason);
    const target = status.targets.find((item) => item.id === spec.targetId);
    if (!target?.available || target.device !== spec.targetDevice) fail("BACKUP_TARGET_CHANGED");
    const base = join(target.path, `everyos-linux-${spec.planId}`);
    const markerPath = join(base, "everyos.json");
    let exists = true;
    try {
      await lstat(base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    const identity = {
      format: "everyos-linux-repository/1",
      planId: spec.planId,
      encryption: spec.encryption,
      device: spec.targetDevice,
    };
    if (!exists) {
      if (!create) throw new OperationError("not_found", "BACKUP_REPOSITORY_MISSING");
      await mkdir(base, { mode: 0o700 });
      await writeFile(markerPath, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
    }
    await this.#secureDirectory(base);
    const marker = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await marker.stat();
      if (
        !info.isFile() ||
        info.size > 4096 ||
        (!this.#options.fixture && (info.uid !== 0 || (info.mode & 0o077) !== 0))
      )
        fail("BACKUP_REPOSITORY_UNTRUSTED");
      const saved: unknown = JSON.parse(await marker.readFile("utf8"));
      if (JSON.stringify(saved) !== JSON.stringify(identity)) fail("BACKUP_REPOSITORY_UNTRUSTED");
    } finally {
      await marker.close();
    }
    const repository = join(base, "repository");
    try {
      await this.#secureDirectory(repository);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    }
    await mkdir(join(base, "runtime"), { mode: 0o700, recursive: true });
    await this.#secureDirectory(join(base, "runtime"));
    return { base, repository, target: target.path };
  }

  async #invoke(
    spec: Spec,
    base: string,
    args: string[],
    signal?: AbortSignal,
    progress?: BorgInvocation["progress"],
    cwd = this.#root,
  ) {
    await this.#repository(spec, args[0] === "init");
    return this.#run({
      binary: this.#binary!,
      args: ["--log-json", "--lock-wait", "5", ...args],
      cwd,
      state: join(base, "runtime"),
      passphrase: spec.passphrase,
      ...(signal ? { signal } : {}),
      ...(progress ? { progress } : {}),
      ...(args[0] === "list" ? { timeoutMs: 25_000 } : {}),
    });
  }

  async preview(selection: LinuxBackupSelection) {
    const status = await this.status();
    if (!status.available) throw new OperationError("unsupported", status.reason);
    const value = await this.#sources(selection);
    return { paths: value.paths.map((p) => (p === "." ? "/" : "/" + p)), excludes: value.excludes };
  }

  async #sources(spec: LinuxBackupSelection): Promise<{ paths: string[]; excludes: string[] }> {
    const directories = await this.#directories();
    let paths =
      spec.scope === "full" ? ["/"] : spec.scope === "system" ? SYSTEM_PATHS : spec.includes;
    let omittedMounts: string[] = [];
    if (!this.#options.fixture) {
      const selected = backupMountSelection(
        backupMounts(await readFile("/proc/self/mountinfo", "utf8")),
        paths,
        spec.scope === "full",
        [...OMIT, ...directories, ...spec.excludes],
      );
      paths = selected.paths;
      omittedMounts = selected.excluded;
    }
    const excludes = [
      ...OMIT,
      ...directories.filter((p) => under(p, this.#root)).map((p) => "/" + relative(this.#root, p)),
      ...spec.excludes,
      ...omittedMounts,
      ...(spec.excludeCaches
        ? ["/var/cache", "/var/lib/docker/overlay2", "/var/lib/containers/storage/overlay"]
        : []),
    ];
    if ((await realpath(this.#root)) !== this.#root) fail("BACKUP_SOURCE_FORBIDDEN");
    const existing: string[] = [];
    for (const path of [...new Set(paths)]) {
      if (
        OMIT.some((p) => under(path, p)) ||
        directories.some((p) => under(join(this.#root, path), p))
      )
        fail("BACKUP_SOURCE_FORBIDDEN");
      try {
        const source = join(this.#root, path);
        // Leaf symlinks are archived as links; symlinked ancestors must never redirect a source.
        const parent = dirname(source);
        if ((await realpath(parent)) !== parent) fail("BACKUP_SOURCE_FORBIDDEN");
        await lstat(source);
        existing.push(path === "/" ? "." : path.slice(1));
      } catch (error) {
        if (spec.scope === "custom" || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
    }
    if (!existing.length || existing.length > 128) fail("BACKUP_SOURCES_INVALID");
    return { paths: existing, excludes: [...new Set(excludes)] };
  }

  async archives(
    spec: Spec,
    signal?: AbortSignal,
  ): Promise<{ archives: LinuxBackupArchive[]; limit: number }> {
    if (this.#active) throw new OperationError("busy", "BACKUP_BUSY");
    const { base, repository } = await this.#repository(spec, false);
    const result = await this.#invoke(
      spec,
      base,
      ["list", "--json", "--last", "1000", repository],
      signal,
    );
    if (result.code !== 0) throw new OperationError("failed", "BORG_LIST_FAILED");
    const data = JSON.parse(result.output) as {
      archives: Array<{ name: string; id: string; time: string }>;
    };
    const metadata = await this.#archiveMetadata(base);
    return {
      limit: 1000,
      archives: data.archives
        .filter((a) => ARCHIVE.test(a.name))
        .map((a) => ({
          name: a.name,
          id: a.id,
          verification: metadata[a.name]?.verification ?? "unknown",
          scope: metadata[a.name]?.scope ?? null,
          createdAt: Date.parse(a.time + (/Z$|[+-]\d{2}:\d{2}$/.test(a.time) ? "" : "Z")),
        }))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  start(input: OperationParams<"backups.linux.start">): LinuxBackupJob {
    if (this.#active) throw new OperationError("busy", "BACKUP_BUSY");
    if (input.spec.encryption !== "none" && input.spec.passphrase.length < 12)
      fail("BACKUP_PASSPHRASE_REQUIRED");
    if (input.kind !== "create" && input.kind !== "prune" && !input.archive)
      fail("BACKUP_ARCHIVE_REQUIRED");
    // Reserve the slot before awaiting filesystem or capability checks.
    const job: LinuxBackupJob = {
      id: randomUUID(),
      planId: input.spec.planId,
      kind: input.kind,
      status: "running",
      stage: "preparing",
      archive: input.archive,
      startedAt: this.#now(),
      finishedAt: null,
      files: 0,
      bytes: 0,
      compressedBytes: 0,
      deduplicatedBytes: 0,
      error: null,
      restorePath: null,
    };
    const controller = new AbortController();
    this.#active = { job, controller };
    this.#jobs.set(job.id, job);
    this.#execution = this.#execute(input, job, controller).finally(() => {
      this.#active = null;
    });
    while (this.#jobs.size > 100) {
      const key = this.#jobs.keys().next().value;
      if (key) this.#jobs.delete(key);
    }
    return { ...job };
  }

  job(id: string): LinuxBackupJob {
    const job = this.#jobs.get(id);
    if (!job) throw new OperationError("not_found", "BACKUP_JOB_MISSING");
    return { ...job };
  }
  cancel(id: string) {
    const match = this.#active?.job.id === id;
    if (match) this.#active!.controller.abort();
    return { cancelled: match };
  }
  async close() {
    this.#active?.controller.abort();
    await this.#execution;
  }

  async #execute(
    input: OperationParams<"backups.linux.start">,
    job: LinuxBackupJob,
    controller: AbortController,
  ) {
    let spaceTimer: NodeJS.Timeout | undefined;
    let outcome: LinuxBackupJob["status"] = "succeeded";
    let noSpace = false;
    let guardFailure: string | null = null;
    let archiveBase: string | null = null;
    let verified = false;
    try {
      const { spec, kind } = input;
      const { base, repository, target } = await this.#repository(spec, kind === "create");
      archiveBase = base;
      const checkSpace = async () => {
        if (controller.signal.aborted) return;
        if ((await this.#device((await lstat(target)).dev)) !== spec.targetDevice) {
          guardFailure = "BACKUP_TARGET_CHANGED";
          controller.abort();
          return;
        }
        const space = await statfs(target);
        if (
          (kind === "create" || kind === "restore") &&
          space.bavail * space.bsize < (this.#options.reserveBytes ?? 1024 ** 3)
        ) {
          noSpace = true;
          controller.abort();
        }
      };
      await checkSpace();
      controller.signal.throwIfAborted();
      spaceTimer = setInterval(() => {
        void checkSpace().catch(() => {
          guardFailure = "BACKUP_TARGET_UNAVAILABLE";
          controller.abort();
        });
      }, 1000);
      spaceTimer.unref();
      const run = (args: string[], cwd?: string) =>
        this.#invoke(
          spec,
          base,
          args,
          controller.signal,
          (value) => {
            if (value.type === "archive_progress") {
              job.files = safeNumber(value.nfiles);
              job.bytes = safeNumber(value.original_size);
              job.compressedBytes = safeNumber(value.compressed_size);
              job.deduplicatedBytes = safeNumber(value.deduplicated_size);
            }
          },
          cwd,
        );
      if (kind === "verify" || kind === "restore") {
        const information = await run(["info", "--json", `${repository}::${job.archive}`]);
        if (information.code !== 0) throw new Error("BORG_ARCHIVE_MISSING");
        const archive = (
          JSON.parse(information.output) as {
            archives?: Array<{ stats?: { original_size?: number } }>;
          }
        ).archives?.[0];
        if (!archive) throw new Error("BORG_ARCHIVE_MISSING");
        if (kind === "restore") {
          const size = safeNumber(archive.stats?.original_size);
          const space = await statfs(target);
          if (space.bavail * space.bsize < size + (this.#options.reserveBytes ?? 1024 ** 3))
            throw new Error("BACKUP_INSUFFICIENT_SPACE");
        }
      }
      if (kind === "create") {
        try {
          await lstat(repository);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const init = await run(["init", `--encryption=${spec.encryption}`, repository]);
          if (init.code !== 0) throw new Error("BORG_INIT_FAILED", { cause: error });
        }
        const sources = await this.#sources(spec);
        job.archive = `eos-${new Date(this.#now()).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${randomUUID().slice(0, 8)}`;
        job.stage = "archiving";
        const result = await run([
          "create",
          "--json",
          "--progress",
          "--comment",
          JSON.stringify({
            format: "everyos-linux-backup/1",
            scope: spec.scope,
            includes: spec.includes,
            excludes: spec.excludes,
            excludeCaches: spec.excludeCaches,
            consistency: "live-filesystem",
          })
            .replaceAll("{", "{{")
            .replaceAll("}", "}}"),
          "--one-file-system",
          "--numeric-ids",
          `--compression=${spec.compression}`,
          ...sources.excludes.flatMap((path) => ["--exclude", `pp:${path.slice(1)}`]),
          "--",
          `${repository}::${job.archive}`,
          ...sources.paths,
        ]);
        if (result.code > 1) throw new Error("BORG_CREATE_FAILED");
        if (result.code === 1) {
          outcome = "warning";
          job.error = "BORG_INCOMPLETE";
          return;
        }
        const data = JSON.parse(result.output) as { archive?: { stats?: Record<string, unknown> } };
        const stats = data.archive?.stats;
        if (stats) {
          job.files = safeNumber(stats.nfiles);
          job.bytes = safeNumber(stats.original_size);
          job.compressedBytes = safeNumber(stats.compressed_size);
          job.deduplicatedBytes = safeNumber(stats.deduplicated_size);
        }
        job.stage = "verifying";
        const verification = await run([
          "check",
          "--archives-only",
          "--verify-data",
          "--glob-archives",
          job.archive,
          repository,
        ]);
        if (verification.code !== 0) throw new Error("BORG_VERIFY_FAILED");
        verified = true;
        if (spec.retention.enabled) await this.#prune(spec, repository, job, run);
      } else if (kind === "verify") {
        job.stage = "verifying";
        if (
          (
            await run([
              "check",
              "--archives-only",
              "--verify-data",
              "--glob-archives",
              job.archive!,
              repository,
            ])
          ).code !== 0
        )
          throw new Error("BORG_VERIFY_FAILED");
        verified = true;
      } else if (kind === "restore") {
        job.stage = "restoring";
        const restores = join(base, "restores");
        await mkdir(restores, { mode: 0o700, recursive: true });
        await this.#secureDirectory(restores);
        const destination = join(restores, job.id);
        await mkdir(destination, { mode: 0o700 });
        // Never extract into / or a person-selected existing directory, even for administrators.
        if (
          (await run(["extract", "--dry-run", `${repository}::${job.archive}`], destination))
            .code !== 0
        )
          throw new Error("BORG_VERIFY_FAILED");
        if (
          (
            await run(
              ["extract", "--numeric-ids", "--sparse", `${repository}::${job.archive}`],
              destination,
            )
          ).code !== 0
        )
          throw new Error("BORG_RESTORE_FAILED");
        job.restorePath = destination;
      } else {
        if (!spec.retention.enabled) fail("BACKUP_RETENTION_DISABLED");
        await this.#prune(spec, repository, job, run);
      }
      outcome = "succeeded";
    } catch (error) {
      outcome = controller.signal.aborted && !noSpace && !guardFailure ? "cancelled" : "failed";
      const message = error instanceof Error ? error.message : "";
      job.error =
        guardFailure ??
        (noSpace
          ? "BACKUP_INSUFFICIENT_SPACE"
          : /^[A-Z_]{1,80}$/.test(message)
            ? message
            : "BORG_OPERATION_FAILED");
    } finally {
      if (spaceTimer) clearInterval(spaceTimer);
      if (archiveBase && job.archive && (job.kind === "create" || job.kind === "verify")) {
        try {
          await this.#repository(input.spec, false);
          const entries = await this.#archiveMetadata(archiveBase);
          const { scope } = input.spec;
          entries[job.archive] = {
            verification:
              outcome === "warning" || entries[job.archive]?.verification === "warning"
                ? "warning"
                : verified
                  ? "verified"
                  : "unknown",
            scope: job.kind === "create" ? scope : (entries[job.archive]?.scope ?? null),
          };
          const temporary = join(archiveBase, `.archive-status-${randomUUID()}`);
          await writeFile(
            temporary,
            JSON.stringify(Object.fromEntries(Object.entries(entries).slice(-10_000))),
            { mode: 0o600, flag: "wx" },
          );
          await rename(temporary, join(archiveBase, "archive-status.json"));
        } catch {
          if (outcome === "succeeded") {
            outcome = "failed";
            job.error = "BORG_METADATA_FAILED";
          }
        }
      }
      job.stage = "done";
      job.finishedAt = this.#now();
      job.status = outcome;
    }
  }

  async #archiveMetadata(
    base: string,
  ): Promise<Record<string, Pick<LinuxBackupArchive, "verification" | "scope">>> {
    const result: Record<string, Pick<LinuxBackupArchive, "verification" | "scope">> = {};
    let handle;
    try {
      handle = await open(
        join(base, "archive-status.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > 16 * 1024 * 1024 ||
        (stat.mode & 0o077) !== 0 ||
        (!this.#options.fixture && stat.uid !== 0)
      )
        fail("BACKUP_REPOSITORY_UNTRUSTED");
      const raw: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        fail("BACKUP_REPOSITORY_UNTRUSTED");
      for (const [name, value] of Object.entries(raw)) {
        if (!ARCHIVE.test(name) || !value || typeof value !== "object") continue;
        const candidate = value as { verification?: unknown; scope?: unknown };
        result[name] = {
          verification:
            candidate.verification === "verified" || candidate.verification === "warning"
              ? candidate.verification
              : "unknown",
          scope:
            candidate.scope === "system" ||
            candidate.scope === "full" ||
            candidate.scope === "custom"
              ? candidate.scope
              : null,
        };
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  async #prune(
    spec: Spec,
    repository: string,
    job: LinuxBackupJob,
    run: (args: string[]) => ReturnType<typeof runBorg>,
  ) {
    job.stage = "retention";
    const r = spec.retention;
    const args = [
      "prune",
      "--glob-archives",
      "eos-" + "[0-9]".repeat(8) + "T" + "[0-9]".repeat(6) + "Z-" + "[a-f0-9]".repeat(8),
      "--keep-last",
      "1",
      "--keep-hourly",
      String(r.hourly),
      "--keep-daily",
      String(r.daily),
      "--keep-weekly",
      String(r.weekly),
      "--keep-monthly",
      String(r.monthly),
      repository,
    ];
    if ((await run(args)).code !== 0 || (await run(["compact", repository])).code !== 0)
      throw new Error("BORG_RETENTION_FAILED");
  }
}
