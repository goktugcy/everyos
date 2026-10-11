import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ReleaseJob, SelfUpdateStatus } from "@everyos/shared";
import { ReleaseJobSchema, ReleaseInstallSchema } from "@everyos/shared/schemas";
import { z } from "zod";
import { compareVersions, verifyRelease } from "./manifest.ts";
import { readReleaseFile } from "./transport.ts";
import {
  UPDATE_ROOT,
  installedVersion,
  releaseConfig,
  stateDirectory,
  trustedPath,
  writeState,
} from "./config.ts";

export const JobRecordSchema = z.strictObject({
  job: ReleaseJobSchema,
  actor: z.strictObject({ userId: z.string().max(128), username: z.string().max(128) }),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;
export const terminal = (job: ReleaseJob) => job.finishedAt !== null;
export function readJob(): JobRecord | null {
  const path = join(UPDATE_ROOT, "job.json");
  if (!existsSync(path)) return null;
  trustedPath(path);
  return JobRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export class SelfUpdateManager {
  constructor(privateMode: "production" | "development") {
    this.mode = privateMode;
  }
  private readonly mode: "production" | "development";
  async status(check = false): Promise<SelfUpdateStatus> {
    const architecture =
      process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
    const base: SelfUpdateStatus = {
      source: "host",
      installedVersion: installedVersion(),
      architecture,
      configured: false,
      reason: null,
      checkedAt: null,
      available: null,
      job: null,
    };
    if (this.mode !== "production") return { ...base, reason: "development-mode" };
    if (process.platform !== "linux") return { ...base, reason: "not-linux" };
    const config = releaseConfig();
    base.job = readJob()?.job ?? null;
    if (!config) return { ...base, reason: "not-configured" };
    base.configured = true;
    const path = join(UPDATE_ROOT, "release.json");
    if (check) {
      stateDirectory();
      const bytes = await readReleaseFile(config, "latest/download/release.json", 128 * 1024);
      verifyRelease(bytes.toString("utf8"), config.publicKey);
      writeState(path, JSON.parse(bytes.toString("utf8")));
      writeState(join(UPDATE_ROOT, "checked-at.json"), { at: Date.now() });
    }
    if (existsSync(path)) {
      trustedPath(path);
      const manifest = verifyRelease(
        readFileSync(path, "utf8"),
        config.publicKey,
        Date.now(),
        true,
      );
      const checked = join(UPDATE_ROOT, "checked-at.json");
      if (existsSync(checked)) {
        trustedPath(checked);
        base.checkedAt = z
          .strictObject({ at: z.number().int().nonnegative() })
          .parse(JSON.parse(readFileSync(checked, "utf8"))).at;
      }
      if (
        manifest.expiresAt > Date.now() &&
        compareVersions(manifest.version, base.installedVersion) > 0
      )
        base.available = {
          version: manifest.version,
          minVersion: manifest.minVersion,
          schemaVersion: manifest.schemaVersion,
          notes: manifest.notes,
          publishedAt: manifest.publishedAt,
        };
    }
    return base;
  }
  async install(input: unknown, actor: { userId: string; username: string }): Promise<ReleaseJob> {
    const params = ReleaseInstallSchema.parse(input);
    if (this.mode !== "production" || process.platform !== "linux")
      throw new Error("Self-update requires a production Linux installation");
    stateDirectory();
    const lock = join(UPDATE_ROOT, "queue.lock");
    if (existsSync(lock)) {
      trustedPath(lock, true);
      const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error("Invalid queue lock; administrator review required");
      try {
        process.kill(pid, 0);
        throw new Error("Another update request is being prepared");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      rmSync(lock, { recursive: true });
    }
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
    try {
      const old = readJob();
      if (old && !terminal(old.job)) throw new Error("An update is already running");
      const worker = await promisify(execFile)(
        "/usr/bin/systemctl",
        ["show", "everyos-update.service", "--property=ActiveState", "--value"],
        { timeout: 10_000 },
      );
      if (!["inactive", "failed"].includes(worker.stdout.trim()))
        throw new Error("The update worker is still active");
      const status = await this.status(true);
      if (
        status.available?.version !== params.version ||
        compareVersions(status.installedVersion, status.available.minVersion) < 0
      )
        throw new Error("Unsupported release or upgrade path");
      const job: ReleaseJob = {
        id: randomUUID(),
        version: params.version,
        previousVersion: status.installedVersion,
        backupId: params.backupId,
        state: "queued",
        createdAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      writeState(join(UPDATE_ROOT, "job.json"), { job, actor });
      try {
        await promisify(execFile)(
          "/usr/bin/systemctl",
          ["start", "--no-block", "everyos-update.service"],
          { timeout: 15_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } },
        );
      } catch {
        job.state = "failed";
        job.error = "worker-start-failed";
        job.finishedAt = Date.now();
        writeState(join(UPDATE_ROOT, "job.json"), { job, actor });
        throw new Error("Could not start the update worker");
      }
      return job;
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
}
