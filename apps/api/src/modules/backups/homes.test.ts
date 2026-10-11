import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { BackupHomeContent } from "@everyos/shared";
import { TarWriter, type TarWriteHeader } from "@everyos/system/archive";
import { describe, expect, it } from "vitest";
import { SpaceGuard } from "./backup-store.ts";
import { archiveHomes, assertHomesUnmounted, restoreHomes, validateHomes } from "./homes.ts";

async function archive(
  dir: string,
  entries: Array<TarWriteHeader & { content?: string }>,
): Promise<string> {
  const chunks: Buffer[] = [];
  const writer = new TarWriter((chunk) => {
    chunks.push(Buffer.from(chunk));
    return Promise.resolve();
  });
  for (const entry of entries) {
    if (entry.type === "directory") await writer.directory(entry);
    else if (entry.type === "symlink") await writer.symlink(entry);
    else await writer.file(entry, Buffer.from(entry.content ?? ""));
  }
  await writer.end();
  const file = join(dir, `${randomUUID()}.tar.gz`);
  await writeFile(file, gzipSync(Buffer.concat(chunks)));
  return file;
}

const home = (id: string, entries: number, bytes = 0): BackupHomeContent => ({
  userId: id,
  username: "user",
  dataBytes: bytes,
  dataEntries: entries,
  skipped: 0,
});
const directory = (name: string): TarWriteHeader => ({
  type: "directory",
  name,
  mode: 0o700,
  mtime: 0,
});

describe("home backup archive", () => {
  it("refuses mounted descendants and escaped mount paths while allowing unrelated mounts", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "everyos homes mounted ")));
    const id = randomUUID();
    const escape = (path: string) => path.replaceAll(" ", "\\040");
    const line = (path: string) => `42 1 8:1 / ${escape(path)} rw - ext4 /dev/test rw`;
    await expect(
      assertHomesUnmounted(root, [id], line(join(root, id, "shared"))),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    await expect(assertHomesUnmounted(root, [id], line(join(root, id)))).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
    await expect(
      assertHomesUnmounted(root, [id], line(join(root, `${id}-other`))),
    ).resolves.toBeUndefined();
  });
  it("captures actual files and links, without reading an outside target or unknown account directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "everyos-home-archive-"));
    const user = randomUUID();
    await mkdir(join(root, user));
    await writeFile(join(root, user, "note.txt"), "inside");
    const outside = await mkdtemp(join(tmpdir(), "everyos-home-outside-"));
    await writeFile(join(outside, "secret.txt"), "NEVER_ARCHIVE_THIS_TARGET");
    await symlink(outside, join(root, user, "escape"));
    const unrelated = randomUUID();
    await mkdir(join(root, unrelated));
    await writeFile(join(root, unrelated, "unknown.txt"), "NEVER_ARCHIVE_UNKNOWN_ACCOUNT");
    const target = join(outside, "homes.tar.gz");
    const homes = await archiveHomes({
      root,
      users: [{ id: user, username: "owner" }],
      target,
      guard: new SpaceGuard(outside, 0),
      signal: new AbortController().signal,
      progress: () => undefined,
    });
    expect(homes).toEqual([
      { userId: user, username: "owner", dataBytes: 6, dataEntries: 3, skipped: 0 },
    ]);
    const bytes = gunzipSync(await readFile(target));
    expect(bytes.includes(Buffer.from("inside"))).toBe(true);
    expect(bytes.includes(Buffer.from("NEVER_ARCHIVE_THIS_TARGET"))).toBe(false);
    expect(bytes.includes(Buffer.from("NEVER_ARCHIVE_UNKNOWN_ACCOUNT"))).toBe(false);
    await expect(validateHomes(target, homes)).resolves.toBeUndefined();
  });

  it("rejects unsafe paths, duplicate entries, missing parents and writes through symlinks before changing a home", async () => {
    const root = await mkdtemp(join(tmpdir(), "everyos-home-unsafe-"));
    const user = randomUUID();
    const prefix = `homes/${user}`;
    const variants: TarWriteHeader[][] = [
      [directory("/homes")],
      [directory("homes"), directory(prefix), directory(`${prefix}/../escape`)],
      [directory("homes"), directory(prefix), directory(prefix)],
      [directory("homes"), directory(prefix), directory(`${prefix}/missing/child`)],
      [directory("homes"), directory(`homes/${randomUUID()}`)],
      [
        directory("homes"),
        directory(prefix),
        { type: "symlink", name: `${prefix}/escape`, linkname: "/tmp", mode: 0o777, mtime: 0 },
        { type: "file", name: `${prefix}/escape/owned`, size: 0, mode: 0o600, mtime: 0 },
      ],
    ];
    await mkdir(join(root, user));
    await writeFile(join(root, user, "keep.txt"), "unchanged");
    for (const entries of variants) {
      const file = await archive(root, entries);
      await expect(
        restoreHomes({
          root,
          archive: file,
          homes: [home(user, 1)],
          users: [user],
          reserveBytes: 0,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      expect(await readFile(join(root, user, "keep.txt"), "utf8")).toBe("unchanged");
    }
    expect((await readdir(root)).some((name) => name.startsWith(".restore-"))).toBe(false);
  });

  it("rolls earlier home swaps back when a later destination is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "everyos-home-rollback-"));
    const first = randomUUID();
    const second = randomUUID();
    await mkdir(join(root, first));
    await writeFile(join(root, first, "old.txt"), "original");
    const outside = await mkdtemp(join(tmpdir(), "everyos-home-rollback-outside-"));
    await writeFile(join(outside, "keep.txt"), "outside");
    await symlink(outside, join(root, second));
    const file = await archive(root, [
      directory("homes"),
      directory(`homes/${first}`),
      {
        type: "file",
        name: `homes/${first}/new.txt`,
        size: 3,
        content: "new",
        mode: 0o600,
        mtime: 0,
      },
      directory(`homes/${second}`),
    ]);
    await expect(
      restoreHomes({
        root,
        archive: file,
        homes: [home(first, 2, 3), home(second, 1)],
        users: [first, second],
        reserveBytes: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    expect(await readFile(join(root, first, "old.txt"), "utf8")).toBe("original");
    expect(await readdir(join(root, first))).toEqual(["old.txt"]);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside");
    expect((await readdir(root)).some((name) => name.startsWith(".restore-"))).toBe(false);
  });

  it("rejects mismatched manifest totals and respects cancellation and the disk reserve", async () => {
    const root = await mkdtemp(join(tmpdir(), "everyos-home-limits-"));
    const user = randomUUID();
    await mkdir(join(root, user));
    await writeFile(join(root, user, "a.txt"), "data");
    const file = await archive(root, [directory("homes"), directory(`homes/${user}`)]);
    await expect(validateHomes(file, [home(user, 1, 10)])).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      archiveHomes({
        root,
        users: [{ id: user, username: "owner" }],
        target: join(root, "cancelled.tar.gz"),
        guard: new SpaceGuard(root, 0),
        signal: controller.signal,
        progress: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      archiveHomes({
        root,
        users: [{ id: user, username: "owner" }],
        target: join(root, "no-space.tar.gz"),
        guard: new SpaceGuard(root, Number.MAX_SAFE_INTEGER),
        signal: new AbortController().signal,
        progress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INSUFFICIENT_SPACE" });
  });
});
