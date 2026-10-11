import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { OperationContext } from "@otuken/agent-protocol";
import { silentLogger } from "@otuken/logger";
import { SecretBox } from "@otuken/security";
import { createDockerSimulator } from "@otuken/system";
import { readTar, TarWriter } from "@otuken/system/archive";
import { afterEach, describe, expect, it } from "vitest";
import { AppDataBackups } from "./app-data-backup.ts";
import { ManagedAppManager } from "./managed-apps.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const compose = "services:\n  app:\n    image: example.invalid/app:1\n";
const userId = randomUUID();
const context = (): OperationContext => ({
  actor: { kind: "user", userId, username: "admin", role: "admin" },
  signal: new AbortController().signal,
  logger: silentLogger,
});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "otuken-appdata-test-")));
  directories.push(dir);
  const docker = createDockerSimulator();
  const apps = new ManagedAppManager({
    docker,
    root: join(dir, "apps"),
    isProtected: () => false,
    secrets: new SecretBox(randomBytes(32)),
  });
  const id = randomUUID();
  await apps.run({ id, action: "install", compose, riskOverride: false }, context());
  const dataDir = join(dir, "apps", id, "data");
  return { apps, backups: new AppDataBackups({ apps, logger: silentLogger }), id, dataDir, dir };
}

async function exportArchive(f: Awaited<ReturnType<typeof fixture>>) {
  const chunks: Buffer[] = [];
  const begin = await f.backups.beginExport({ id: f.id }, context());
  for (;;) {
    const part = await f.backups.readExport({ token: begin.token }, context());
    if (part.done) {
      const archive = Buffer.concat(chunks);
      return { archive, begin, end: part };
    }
    chunks.push(Buffer.from(part.data, "base64"));
  }
}

async function importArchive(f: Awaited<ReturnType<typeof fixture>>, archive: Buffer) {
  const { token } = await f.backups.begin({ id: f.id, size: archive.length }, context());
  for (let offset = 0; offset < archive.length; offset += 512 * 1024)
    await f.backups.chunk(
      { token, offset, data: archive.subarray(offset, offset + 512 * 1024).toString("base64") },
      context(),
    );
  return f.backups.commit(
    { token, sha256: createHash("sha256").update(archive).digest("hex") },
    context(),
  );
}

async function tarGz(build: (writer: TarWriter) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const writer = new TarWriter((chunk) => {
    chunks.push(Buffer.from(chunk));
    return Promise.resolve();
  });
  await build(writer);
  await writer.end();
  return gzipSync(Buffer.concat(chunks));
}

describe("app data backups", () => {
  it("refuses to archive a running app and locks the app while exporting", async () => {
    const f = await fixture();
    await expect(exportArchive(f)).rejects.toThrow("APP_RUNNING");
    await f.apps.run({ id: f.id, action: "stop", compose, riskOverride: false }, context());
    const { token } = await f.backups.beginExport({ id: f.id }, context());
    await expect(
      f.apps.run({ id: f.id, action: "start", compose, riskOverride: false }, context()),
    ).rejects.toThrow("in progress");
    expect(await f.backups.abortExport({ token }, context())).toEqual({ aborted: true });
    await expect(f.backups.readExport({ token }, context())).rejects.toThrow("No such");
    expect(
      await f.apps.run({ id: f.id, action: "start", compose, riskOverride: false }, context()),
    ).toMatchObject({ ok: true });
  });

  it("archives a stopped app's data and restores it in place", async () => {
    const f = await fixture();
    await f.apps.run({ id: f.id, action: "stop", compose, riskOverride: false }, context());
    await mkdir(join(f.dataDir, "db", "nested"), { recursive: true });
    await writeFile(join(f.dataDir, "db", "nested", "table.dat"), randomBytes(900_000));
    await writeFile(join(f.dataDir, "config.json"), '{"a":1}', { mode: 0o640 });
    await symlink("config.json", join(f.dataDir, "current"));

    const { archive, begin, end } = await exportArchive(f);
    expect(begin).toMatchObject({ entries: 6, skipped: 0 });
    expect(end.size).toBe(archive.length);
    expect(end.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
    // The transfer released the app: it can be exported again.
    await exportArchive(f);
    const names: string[] = [];
    for await (const entry of readTar([gunzipSync(archive)])) names.push(entry.name);
    expect(names).toEqual([
      "data",
      "data/config.json",
      "data/current",
      "data/db",
      "data/db/nested",
      "data/db/nested/table.dat",
    ]);
    const original = await readFile(join(f.dataDir, "db", "nested", "table.dat"));

    // Change the data, then restore the archive.
    await rm(join(f.dataDir, "db"), { recursive: true });
    await writeFile(join(f.dataDir, "config.json"), "changed");
    await writeFile(join(f.dataDir, "new-file"), "x");
    expect(await importArchive(f, archive)).toEqual({ entries: 6, bytes: original.length + 7 });
    expect(await readFile(join(f.dataDir, "db", "nested", "table.dat"))).toEqual(original);
    expect(await readFile(join(f.dataDir, "config.json"), "utf8")).toBe('{"a":1}');
    expect((await stat(join(f.dataDir, "config.json"))).mode & 0o777).toBe(0o640);
    expect(await readlink(join(f.dataDir, "current"))).toBe("config.json");
    expect(await lstat(join(f.dataDir, "new-file")).catch(() => null)).toBeNull();
    // Nothing is left behind next to the data.
    expect((await readdir(join(f.dir, "apps", f.id))).filter((n) => n.startsWith("."))).toEqual([]);
    expect((await readdir(join(f.dir, "apps"))).filter((n) => n.startsWith(".import"))).toEqual([]);
  });

  it("releases the app when an export is abandoned halfway", async () => {
    const f = await fixture();
    await f.apps.run({ id: f.id, action: "stop", compose, riskOverride: false }, context());
    // Incompressible data, so the producer is still writing when we stop reading.
    await writeFile(join(f.dataDir, "big.bin"), randomBytes(8 * 1024 * 1024));
    const { token } = await f.backups.beginExport({ id: f.id }, context());
    const first = await f.backups.readExport({ token }, context());
    expect(first.done).toBe(false);
    expect(await f.backups.abortExport({ token }, context())).toEqual({ aborted: true });
    expect(
      await f.apps.run({ id: f.id, action: "start", compose, riskOverride: false }, context()),
    ).toMatchObject({ ok: true });
  });

  it("rejects unsafe archives without touching the data", async () => {
    const f = await fixture();
    await f.apps.run({ id: f.id, action: "stop", compose, riskOverride: false }, context());
    await writeFile(join(f.dataDir, "keep.txt"), "original");
    const header = { mode: 0o755, mtime: 0 };
    const cases = [
      // Escaping the data directory.
      await tarGz(async (w) => {
        await w.directory({ ...header, name: "data" });
        await w.file({ ...header, name: "data/../../evil", size: 1 }, Buffer.from("x"));
      }),
      // Writing through a symlink placed earlier in the archive.
      await tarGz(async (w) => {
        await w.directory({ ...header, name: "data" });
        await w.symlink({ ...header, name: "data/link", linkname: "/etc" });
        await w.file({ ...header, name: "data/link/passwd", size: 1 }, Buffer.from("x"));
      }),
      // Not starting with the data directory.
      await tarGz(async (w) => {
        await w.file({ ...header, name: "other.txt", size: 1 }, Buffer.from("x"));
      }),
      // Duplicate member.
      await tarGz(async (w) => {
        await w.directory({ ...header, name: "data" });
        await w.file({ ...header, name: "data/a", size: 1 }, Buffer.from("x"));
        await w.file({ ...header, name: "data/a", size: 1 }, Buffer.from("y"));
      }),
      gzipSync(Buffer.from("not a tar archive at all".repeat(40))),
    ];
    for (const archive of cases) await expect(importArchive(f, archive)).rejects.toThrow();
    expect(await readFile(join(f.dataDir, "keep.txt"), "utf8")).toBe("original");
    expect((await readdir(join(f.dir, "apps", f.id))).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("checks the transfer: offsets, size, checksum and the uploading user", async () => {
    const f = await fixture();
    const { token } = await f.backups.begin({ id: f.id, size: 4 }, context());
    await expect(
      f.backups.chunk({ token, offset: 2, data: Buffer.from("ab").toString("base64") }, context()),
    ).rejects.toThrow("offset");
    const other: OperationContext = {
      ...context(),
      actor: { kind: "user", userId: randomUUID(), username: "x", role: "admin" },
    };
    await expect(
      f.backups.chunk({ token, offset: 0, data: Buffer.from("ab").toString("base64") }, other),
    ).rejects.toThrow("No such restore upload");
    await f.backups.chunk(
      { token, offset: 0, data: Buffer.from("abcd").toString("base64") },
      context(),
    );
    await expect(f.backups.commit({ token, sha256: "0".repeat(64) }, context())).rejects.toThrow(
      "checksum",
    );
    // A failed commit releases the upload.
    await expect(f.backups.chunk({ token, offset: 4, data: "" }, context())).rejects.toThrow(
      "No such restore upload",
    );
    expect((await readdir(join(f.dir, "apps"))).filter((n) => n.startsWith(".import"))).toEqual([]);
  });
});
