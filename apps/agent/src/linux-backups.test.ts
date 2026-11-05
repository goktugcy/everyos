import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  link,
  symlink,
  readlink,
  rm,
  realpath,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LinuxBackups, type LinuxBackupOptions } from "./linux-backups.ts";
import type { OperationParams } from "@everyos/agent-protocol";
import { runBorg } from "./linux-backup-runner.ts";

type Spec = OperationParams<"backups.linux.start">["spec"];
const binary = process.env.EVERYOS_TEST_BORG;

async function fixture(overrides: Partial<LinuxBackupOptions> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "everyos-linux-backups-")));
  const root = join(base, "source");
  const target = join(base, "target");
  await mkdir(root, { mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  for (const directory of ["etc", "usr", "home", "proc"]) await mkdir(join(root, directory));
  await writeFile(join(root, "etc/setting"), "system-configuration\n", { mode: 0o640 });
  await writeFile(join(root, "usr/tool"), "binary-fixture\n", { mode: 0o750 });
  await writeFile(join(root, "home/note"), "preserve-this-exact-data\n", { mode: 0o640 });
  await writeFile(join(root, "home/private"), "explicitly-excluded\n");
  await writeFile(join(root, "proc/virtual"), "must-never-be-captured\n");
  const engine = new LinuxBackups({
    mode: "development",
    directories: [target],
    fixture: { root, binary: binary ?? "/unused" },
    reserveBytes: 0,
    ...overrides,
  });
  const targetInfo = await lstat(target);
  const statusId = (await import("node:crypto"))
    .createHash("sha256")
    .update(target)
    .digest("hex")
    .slice(0, 16);
  const spec: Spec = {
    planId: randomUUID(),
    targetId: statusId,
    targetDevice: String(targetInfo.dev),
    scope: "full",
    includes: [],
    excludes: ["/home/private"],
    excludeCaches: true,
    encryption: "none",
    passphrase: "",
    compression: "lz4",
    retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 12 },
  };
  return {
    base,
    root,
    target,
    engine,
    spec,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

async function done(engine: LinuxBackups, input: OperationParams<"backups.linux.start">) {
  const start = engine.start(input);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = engine.job(start.id);
    if (current.status !== "running") return current;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  engine.cancel(start.id);
  throw new Error("Fixture Borg job did not finish");
}

describe("Linux backup policy", () => {
  it("never enables host backups from a normal development agent", async () => {
    const engine = new LinuxBackups({ mode: "development", directories: [] });
    expect(await engine.status()).toMatchObject({
      available: false,
      reason: "development-mode",
      source: "host",
    });
  });
});

describe.skipIf(!binary)("real Borg fixture backup and restore", () => {
  it("restores exact data, permissions, hardlinks and leaf symlinks; excludes virtual and selected files", async () => {
    const f = await fixture();
    try {
      await link(join(f.root, "home/note"), join(f.root, "home/linked"));
      await symlink("note", join(f.root, "home/alias"));
      const sparse = await open(join(f.root, "home/sparse"), "w");
      await sparse.truncate(32 * 1024 * 1024);
      await sparse.write(Buffer.from([42]), 0, 1, 32 * 1024 * 1024 - 1);
      await sparse.close();
      if (process.platform === "linux") {
        execFileSync("setfattr", [
          "-n",
          "user.everyos-fixture",
          "-v",
          "preserved",
          join(f.root, "home/note"),
        ]);
        execFileSync("setfacl", ["-m", "u:65534:r--", join(f.root, "home/note")]);
      }
      const created = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(created, created.error ?? "").toMatchObject({ status: "succeeded", kind: "create" });
      expect(created.files).toBeGreaterThan(0);
      expect(created.bytes).toBeGreaterThan(32 * 1024 * 1024);
      const archives = await f.engine.archives(f.spec);
      expect(archives.archives).toHaveLength(1);
      expect(archives.archives[0]!.createdAt).toBeGreaterThan(0);
      expect(archives.archives[0]).toMatchObject({ verification: "verified", scope: "full" });
      await writeFile(join(f.root, "home/note"), "changed-after-backup");
      const restored = await done(f.engine, {
        spec: f.spec,
        kind: "restore",
        archive: created.archive,
      });
      expect(restored, restored.error ?? "").toMatchObject({ status: "succeeded" });
      const destination = restored.restorePath!;
      expect(destination.startsWith(f.target + "/")).toBe(true);
      expect(await readFile(join(destination, "home/note"), "utf8")).toBe(
        "preserve-this-exact-data\n",
      );
      expect(await readFile(join(f.root, "home/note"), "utf8")).toBe("changed-after-backup");
      expect((await lstat(join(destination, "home/note"))).mode & 0o777).toBe(0o640);
      expect((await lstat(join(destination, "home/note"))).ino).toBe(
        (await lstat(join(destination, "home/linked"))).ino,
      );
      expect(await readlink(join(destination, "home/alias"))).toBe("note");
      await expect(lstat(join(destination, "home/private"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(destination, "proc/virtual"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const sparseInfo = await lstat(join(destination, "home/sparse"));
      expect(sparseInfo.size).toBe(32 * 1024 * 1024);
      expect(sparseInfo.blocks * 512).toBeLessThan(sparseInfo.size);
      if (process.platform === "linux") {
        expect(
          execFileSync(
            "getfattr",
            ["--only-values", "-n", "user.everyos-fixture", join(destination, "home/note")],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim(),
        ).toBe("preserved");
        expect(
          execFileSync("getfacl", ["-n", "-cp", join(destination, "home/note")], {
            encoding: "utf8",
          }),
        ).toContain("user:65534:r--");
        expect((await lstat(join(destination, "home/note"))).uid).toBe(
          (await lstat(join(f.root, "home/note"))).uid,
        );
      }
    } finally {
      await f.engine.close();
      await f.cleanup();
    }
  }, 90_000);

  it("creates genuinely encrypted repositories and refuses an incorrect passphrase", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.root, "--exclude=home"));
      await writeFile(join(f.root, "--exclude=home/payload"), "option-like-name");
      f.spec.scope = "custom";
      f.spec.includes = ["/etc", "/--exclude=home"];
      f.spec.encryption = "repokey-blake2";
      f.spec.passphrase = "Owned fixture passphrase only";
      const created = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(created, created.error ?? "").toMatchObject({ status: "succeeded" });
      const base = join(f.target, `everyos-linux-${f.spec.planId}`);
      const info = await runBorg({
        binary: binary!,
        args: ["info", "--json", join(base, "repository") + "::" + created.archive],
        cwd: f.root,
        state: join(base, "runtime"),
        passphrase: f.spec.passphrase,
      });
      expect(info.code).toBe(0);
      expect(JSON.parse(info.output).encryption.mode).toBe("repokey-blake2");
      const information = JSON.parse(info.output) as {
        encryption: { mode: string };
        archives: Array<{ comment: string }>;
      };
      expect(JSON.parse(information.archives[0]!.comment)).toMatchObject({
        scope: "custom",
        includes: ["/etc", "/--exclude=home"],
        consistency: "live-filesystem",
      });
      await expect(
        f.engine.archives({ ...f.spec, passphrase: "Incorrect fixture passphrase" }),
      ).rejects.toThrow("BORG_LIST_FAILED");
      const restored = await done(f.engine, {
        spec: f.spec,
        kind: "restore",
        archive: created.archive,
      });
      expect(restored, restored.error ?? "").toMatchObject({ status: "succeeded" });
      expect(await readFile(join(restored.restorePath!, "etc/setting"), "utf8")).toBe(
        "system-configuration\n",
      );
      expect(await readFile(join(restored.restorePath!, "--exclude=home/payload"), "utf8")).toBe(
        "option-like-name",
      );
    } finally {
      await f.engine.close();
      await f.cleanup();
    }
  }, 90_000);

  it("system-only excludes user data and rejects device changes or an untrusted repository marker", async () => {
    const f = await fixture();
    try {
      f.spec.scope = "system";
      await symlink("../", join(f.root, "escape"));
      await expect(
        f.engine.preview({
          scope: "custom",
          includes: ["/escape/source/etc"],
          excludes: [],
          excludeCaches: false,
        }),
      ).rejects.toThrow("BACKUP_SOURCE_FORBIDDEN");
      const created = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(created, created.error ?? "").toMatchObject({ status: "succeeded" });
      const restored = await done(f.engine, {
        spec: f.spec,
        kind: "restore",
        archive: created.archive,
      });
      expect(restored.status).toBe("succeeded");
      await expect(lstat(join(restored.restorePath!, "home/note"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const changed = await done(f.engine, {
        spec: { ...f.spec, targetDevice: "0" },
        kind: "create",
        archive: null,
      });
      expect(changed).toMatchObject({ status: "failed", error: "BACKUP_TARGET_CHANGED" });
      await writeFile(join(f.target, `everyos-linux-${f.spec.planId}`, "everyos.json"), "{}");
      const untrusted = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(untrusted).toMatchObject({ status: "failed", error: "BACKUP_REPOSITORY_UNTRUSTED" });
    } finally {
      await f.engine.close();
      await f.cleanup();
    }
  }, 90_000);

  it("keeps capture warnings after a later successful data check", async () => {
    const f = await fixture({
      run: async (input) => {
        const result = await runBorg(input);
        return input.args.includes("create") && result.code === 0 ? { ...result, code: 1 } : result;
      },
    });
    try {
      const created = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(created).toMatchObject({ status: "warning", error: "BORG_INCOMPLETE" });
      const verified = await done(f.engine, {
        spec: f.spec,
        kind: "verify",
        archive: created.archive,
      });
      expect(verified, verified.error ?? "").toMatchObject({ status: "succeeded" });
      expect((await f.engine.archives(f.spec)).archives[0]?.verification).toBe("warning");
    } finally {
      await f.engine.close();
      await f.cleanup();
    }
  }, 90_000);

  it("prunes only owned archive names and preserves the latest backup", async () => {
    const f = await fixture();
    try {
      const created = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(created.status).toBe("succeeded");
      const base = join(f.target, `everyos-linux-${f.spec.planId}`);
      const repository = join(base, "repository");
      for (const name of ["eos-20000101T000000Z-12345678", "eos-manually-kept"]) {
        const captured = await runBorg({
          binary: binary!,
          args: ["create", "--timestamp", "2000-01-01T00:00:00", repository + "::" + name, "etc"],
          cwd: f.root,
          state: join(base, "runtime"),
          passphrase: "",
        });
        expect(captured.code).toBe(0);
      }
      f.spec.retention = { enabled: true, hourly: 0, daily: 0, weekly: 0, monthly: 0 };
      const pruned = await done(f.engine, { spec: f.spec, kind: "prune", archive: null });
      expect(pruned, pruned.error ?? "").toMatchObject({ status: "succeeded" });
      expect((await f.engine.archives(f.spec)).archives.map((a) => a.name)).toEqual([
        created.archive,
      ]);
      const list = await runBorg({
        binary: binary!,
        args: ["list", "--json", repository],
        cwd: f.root,
        state: join(base, "runtime"),
        passphrase: "",
      });
      expect(
        (JSON.parse(list.output) as { archives: Array<{ name: string }> }).archives.map(
          (a) => a.name,
        ),
      ).toContain("eos-manually-kept");
    } finally {
      await f.engine.close();
      await f.cleanup();
    }
  }, 90_000);
  it("deletes only the confirmed archive and preserves other backups and source files", async () => {
    const f = await fixture();
    try {
      const first = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(first, first.error ?? "").toMatchObject({ status: "succeeded" });
      const second = await done(f.engine, { spec: f.spec, kind: "create", archive: null });
      expect(second, second.error ?? "").toMatchObject({ status: "succeeded" });
      expect(() =>
        f.engine.start({ spec: f.spec, kind: "delete", archive: first.archive }),
      ).toThrow("BACKUP_DELETE_CONFIRMATION_REQUIRED");
      const deleted = await done(f.engine, {
        spec: f.spec,
        kind: "delete",
        archive: first.archive,
        confirm: true,
      });
      expect(deleted, deleted.error ?? "").toMatchObject({ status: "succeeded", kind: "delete" });
      expect((await f.engine.archives(f.spec)).archives.map((a) => a.name)).toEqual([
        second.archive,
      ]);
      expect(await readFile(join(f.root, "etc/setting"), "utf8")).toBe("system-configuration\n");
      const base = join(f.target, `everyos-linux-${f.spec.planId}`);
      expect(
        JSON.parse(await readFile(join(base, "archive-status.json"), "utf8")),
      ).not.toHaveProperty(first.archive!);
      const restored = await done(f.engine, {
        spec: f.spec,
        kind: "restore",
        archive: second.archive,
      });
      expect(restored, restored.error ?? "").toMatchObject({ status: "succeeded" });
      expect(await readFile(join(restored.restorePath!, "home/note"), "utf8")).toBe(
        "preserve-this-exact-data\n",
      );
      const missing = await done(f.engine, {
        spec: f.spec,
        kind: "delete",
        archive: first.archive,
        confirm: true,
      });
      expect(missing).toMatchObject({ status: "failed", error: "BORG_ARCHIVE_MISSING" });
    } finally {
      await f.engine.close();
      await f.cleanup();
    }
  }, 240_000);
});
