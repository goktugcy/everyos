import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  lstatSync,
  chownSync,
  renameSync,
  realpathSync,
  openSync,
  closeSync,
  fsyncSync,
  statfsSync,
  constants,
  writeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createLogger } from "@everyos/logger";
import { packageDigest, verifyRelease, compareVersions } from "./manifest.ts";
import { readReleaseFile } from "./transport.ts";
import { readJob, type JobRecord } from "./manager.ts";
import {
  releaseConfig,
  UPDATE_ROOT,
  stateDirectory,
  trustedPath,
  writeState,
  type ReleaseConfig,
} from "./config.ts";
import type { ReleaseJobState } from "@everyos/shared";

const execute = promisify(execFile);
const logger = createLogger({ name: "everyos-update", level: "info", format: "json" });
const environment = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  EVERYOS_PACKAGE_TRANSACTION: "1",
  DEBIAN_FRONTEND: "noninteractive",
};
const command = (file: string, args: string[]) =>
  execute(file, args, { env: environment, timeout: 15 * 60_000, maxBuffer: 1024 * 1024 });
const units = ["everyos-api.service", "everyos-agent.service"];
const transactionPath = join(UPDATE_ROOT, "transaction.json");
const snapshotPath = join(UPDATE_ROOT, "snapshot");
const maintenance = "/run/everyos-update-maintenance";
const TransactionSchema = z.strictObject({
  jobId: z.uuid(),
  snapshot: z.boolean(),
  installing: z.boolean(),
  uid: z.number().int(),
  gid: z.number().int(),
});
type Transaction = z.infer<typeof TransactionSchema>;

function update(record: JobRecord, state: ReleaseJobState, error: string | null = null): void {
  record.job.state = state;
  record.job.error = error;
  if (["succeeded", "rolled-back", "failed"].includes(state)) record.job.finishedAt = Date.now();
  writeState(join(UPDATE_ROOT, "job.json"), record);
  // The append-only root audit survives database restore and volatile journal configurations.
  const event = {
    at: Date.now(),
    event: "release.update",
    jobId: record.job.id,
    version: record.job.version,
    backupId: record.job.backupId,
    actor: record.actor,
    state,
    error,
  };
  const fd = openSync(
    join(UPDATE_ROOT, "audit.jsonl"),
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify(event) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  logger.info("EveryOS release update", event);
}
async function health(config: ReleaseConfig): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(config.healthUrl, {
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      const body = (await response.json()) as { status?: unknown };
      if (response.ok && body.status === "ok") {
        await command("/usr/bin/systemctl", ["is-active", "--quiet", ...units]);
        return;
      }
    } catch {
      /* Both services may still be starting. */
    }
    await delay(1000);
  }
  throw new Error("health-check-failed");
}
function cachedPackage(config: ReleaseConfig, version: string): string {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const directory = join(UPDATE_ROOT, "packages", version);
  trustedPath(directory, true);
  const metadata = join(directory, "release.json");
  trustedPath(metadata);
  const manifest = verifyRelease(
    readFileSync(metadata, "utf8"),
    config.publicKey,
    Date.now(),
    true,
  );
  if (manifest.version !== version) throw new Error("Recovery release mismatch");
  const artifact = manifest.artifacts[arch];
  const file = join(directory, artifact.file);
  trustedPath(file);
  const info = lstatSync(file);
  if (info.size !== artifact.size || packageDigest(readFileSync(file)) !== artifact.sha256)
    throw new Error("Recovery package checksum mismatch");
  return file;
}
function restoreSnapshot(config: ReleaseConfig, transaction: Transaction): void {
  for (const name of ["everyos.db", "everyos.db-wal", "everyos.db-shm"]) {
    const target = join(config.dataDir, name);
    rmSync(target, { force: true });
    const source = join(snapshotPath, name);
    if (existsSync(source)) {
      const temp = join(config.dataDir, `.update-${name}`);
      rmSync(temp, { force: true });
      cpSync(source, temp, { dereference: false, errorOnExist: true, force: false });
      chownSync(temp, transaction.uid, transaction.gid);
      syncFile(temp);
      renameSync(temp, target);
    }
  }
  syncFile(config.dataDir);
}
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function recover(
  record: JobRecord,
  config: ReleaseConfig,
  transaction: Transaction,
): Promise<void> {
  update(record, "rolling-back", record.job.error);
  await command("/usr/bin/systemctl", ["stop", ...units]);
  if (transaction.installing) {
    const previous = cachedPackage(config, record.job.previousVersion);
    await command("/usr/bin/dpkg", ["--force-confold", "--install", previous]);
  }
  if (transaction.snapshot) restoreSnapshot(config, transaction);
  await command("/usr/bin/systemctl", ["reset-failed", ...units]);
  await command("/usr/bin/systemctl", ["start", "everyos-agent.service", "everyos-api.service"]);
  await health(config);
  update(record, "rolled-back", record.job.error ?? "new-release-failed-health-or-installation");
  rmSync(transactionPath, { force: true });
  rmSync(maintenance, { force: true });
}
export async function runWorker(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("The update worker requires Linux root");
  stateDirectory();
  const record = readJob();
  if (!record) return;
  if (record.job.finishedAt !== null) {
    if (existsSync(maintenance) && readFileSync(maintenance, "utf8") === record.job.id)
      rmSync(maintenance);
    if (existsSync(transactionPath)) {
      trustedPath(transactionPath);
      const old = TransactionSchema.parse(JSON.parse(readFileSync(transactionPath, "utf8")));
      if (old.jobId === record.job.id) rmSync(transactionPath);
    }
    return;
  }
  const config = releaseConfig();
  if (!config) throw new Error("Release source is not configured");
  const oldTransaction = existsSync(transactionPath)
    ? TransactionSchema.parse(JSON.parse(readFileSync(transactionPath, "utf8")))
    : null;
  if (oldTransaction) {
    if (oldTransaction.jobId !== record.job.id) throw new Error("Transaction identity mismatch");
    await recover(record, config, oldTransaction);
    return;
  }
  let transaction: Transaction | null = null;
  let failure = "release-metadata-invalid";
  try {
    update(record, "downloading");
    const bytes = await readReleaseFile(config, "latest/download/release.json", 128 * 1024);
    const manifest = verifyRelease(bytes.toString("utf8"), config.publicKey);
    if (
      manifest.version !== record.job.version ||
      compareVersions(record.job.previousVersion, manifest.minVersion) < 0 ||
      compareVersions(manifest.version, record.job.previousVersion) <= 0
    )
      throw new Error("unsupported-upgrade-path");
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
    if (!arch) throw new Error("unsupported-architecture");
    // Recovery is verified before any service is stopped.
    failure = "recovery-package-invalid";
    cachedPackage(config, record.job.previousVersion);
    const artifact = manifest.artifacts[arch];
    failure = "package-download-failed";
    const data = await readReleaseFile(
      config,
      `download/v${manifest.version}/${artifact.file}`,
      artifact.size,
    );
    update(record, "verifying");
    failure = "package-verification-failed";
    if (data.length !== artifact.size || packageDigest(data) !== artifact.sha256)
      throw new Error("package-checksum-mismatch");
    const directory = join(UPDATE_ROOT, "packages", manifest.version);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    trustedPath(directory, true);
    const candidate = join(directory, artifact.file);
    const temporary = join(directory, "candidate.tmp");
    rmSync(temporary, { force: true });
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    syncFile(temporary);
    renameSync(temporary, candidate);
    writeState(join(directory, "release.json"), JSON.parse(bytes.toString("utf8")));
    const result = await command("/usr/bin/dpkg-deb", [
      "--field",
      candidate,
      "Package",
      "Version",
      "Architecture",
    ]);
    if (
      result.stdout.trim() !==
      `Package: everyos\nVersion: ${manifest.version}\nArchitecture: ${arch}`
    )
      throw new Error("package-identity-mismatch");
    const dataInfo = lstatSync(config.dataDir);
    if (!dataInfo.isDirectory() || realpathSync(config.dataDir) !== config.dataDir)
      throw new Error("unsafe-data-directory");
    trustedPath(dirname(config.dataDir), true);
    if (!existsSync(join(config.dataDir, "everyos.db")))
      throw new Error("Unsupported database path");
    const space = statfsSync(UPDATE_ROOT);
    const databaseSize = lstatSync(join(config.dataDir, "everyos.db")).size;
    if (space.bavail * space.bsize < data.length * 2 + databaseSize * 2 + 256 * 1024 * 1024)
      throw new Error("Insufficient update/recovery space");
    // Fail before downtime if another package manager already owns either lock.
    await command("/usr/bin/python3", [
      "-c",
      "import fcntl; files=[open(p,'r+') for p in ['/var/lib/dpkg/lock-frontend','/var/lib/dpkg/lock']]; [fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB) for f in files]",
    ]);
    transaction = {
      jobId: record.job.id,
      snapshot: false,
      installing: false,
      uid: dataInfo.uid,
      gid: dataInfo.gid,
    };
    writeState(transactionPath, transaction);
    failure = "snapshot-failed";
    writeFileSync(maintenance, record.job.id, { mode: 0o644, flag: "w" });
    await command("/usr/bin/systemctl", ["stop", ...units]);
    rmSync(snapshotPath, { recursive: true, force: true });
    mkdirSync(snapshotPath, { mode: 0o700 });
    for (const name of ["everyos.db", "everyos.db-wal", "everyos.db-shm"]) {
      const source = join(config.dataDir, name);
      if (!existsSync(source)) continue;
      if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
        throw new Error("unsafe-database-file");
      cpSync(source, join(snapshotPath, name), { dereference: false });
      syncFile(join(snapshotPath, name));
    }
    syncFile(snapshotPath);
    const db = new DatabaseSync(join(snapshotPath, "everyos.db"), { readOnly: true });
    try {
      const check = db.prepare("PRAGMA integrity_check").get();
      if (check?.["integrity_check"] !== "ok") throw new Error("snapshot-integrity-failed");
    } finally {
      db.close();
    }
    transaction.snapshot = true;
    transaction.installing = true;
    writeState(transactionPath, transaction);
    update(record, "installing");
    failure = "dpkg-install-failed";
    await command("/usr/bin/dpkg", ["--force-confold", "--install", candidate]);
    update(record, "restarting");
    failure = "service-health-failed";
    await command("/usr/bin/systemctl", ["start", "everyos-agent.service", "everyos-api.service"]);
    await health(config);
    const migrated = new DatabaseSync(join(config.dataDir, "everyos.db"), { readOnly: true });
    try {
      if (
        migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.[
          "version"
        ] !== manifest.schemaVersion
      )
        throw new Error("Schema version mismatch");
    } finally {
      migrated.close();
    }
    // The bundled binaries and dpkg metadata must agree with the signed release.
    const installed = await command("/usr/bin/dpkg-query", [
      "--show",
      "--showformat=${Version}",
      "everyos",
    ]);
    if (
      installed.stdout !== manifest.version ||
      readFileSync("/usr/lib/everyos/VERSION", "utf8").trim() !== manifest.version
    )
      throw new Error("installed-version-mismatch");
    update(record, "succeeded");
    rmSync(transactionPath, { force: true });
    rmSync(maintenance, { force: true });
  } catch {
    record.job.error = failure;
    if (transaction) await recover(record, config, transaction);
    else update(record, "failed", failure);
  }
}
if (process.argv[1]?.endsWith("worker.mjs")) {
  runWorker().catch(() => {
    process.stderr.write(
      "EveryOS update recovery needs administrator attention; see the root journal.\n",
    );
    process.exitCode = 1;
  });
}
