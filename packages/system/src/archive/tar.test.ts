import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveSize,
  readTar,
  safeRelativePath,
  sinkTo,
  TarError,
  TarWriter,
  type TarReadEntry,
} from "./tar.ts";

async function pack(build: (writer: TarWriter) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const writer = new TarWriter((chunk) => {
    chunks.push(Buffer.from(chunk));
    return Promise.resolve();
  });
  await build(writer);
  await writer.end();
  return Buffer.concat(chunks);
}

async function collect(
  archive: Buffer | AsyncIterable<Buffer>,
): Promise<Array<Omit<TarReadEntry, "content"> & { text: string }>> {
  const source = Buffer.isBuffer(archive)
    ? (function* () {
        // Odd chunk sizes exercise the block reassembly.
        for (let i = 0; i < archive.length; i += 777) yield archive.subarray(i, i + 777);
      })()
    : archive;
  const out = [];
  for await (const entry of readTar(source)) {
    const { content, ...header } = entry;
    const parts: Buffer[] = [];
    for await (const chunk of content) parts.push(chunk);
    out.push({ ...header, text: Buffer.concat(parts).toString("utf8") });
  }
  return out;
}

const hasTar = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let temp: string | null = null;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = null;
});

describe("tar", () => {
  it("round-trips files, directories, links, long names and large ids", async () => {
    const longName = `data/${"ç".repeat(60)}/${"uzun-dosya-adı-".repeat(12)}.txt`;
    const headers = [
      { name: "data", type: "directory", mode: 0o750, mtime: 1_700_000_000_000 },
      {
        name: "data/a.txt",
        type: "file",
        size: 5,
        mode: 0o640,
        uid: 999,
        gid: 999,
        mtime: 1_700_000_001_000,
      },
      { name: longName, type: "file", size: 3, mode: 0o600, uid: 4_000_000, gid: 70, mtime: 0 },
      {
        name: "data/link",
        type: "symlink",
        linkname: `../${"x".repeat(150)}`,
        mode: 0o777,
        mtime: 0,
      },
    ] as const;
    const archive = await pack(async (writer) => {
      await writer.directory(headers[0]);
      await writer.file(headers[1], Buffer.from("hello"));
      await writer.file(headers[2], Readable.from([Buffer.from("ab"), Buffer.from("c")]));
      await writer.symlink(headers[3]);
    });
    expect(archive.length % 512).toBe(0);
    expect(archiveSize([...headers])).toBe(archive.length);
    const entries = await collect(archive);
    expect(entries.map((e) => [e.name, e.type, e.text])).toEqual([
      ["data", "directory", ""],
      ["data/a.txt", "file", "hello"],
      [longName, "file", "abc"],
      ["data/link", "symlink", ""],
    ]);
    expect(entries[1]).toMatchObject({ mode: 0o640, uid: 999, gid: 999, mtime: 1_700_000_001_000 });
    expect(entries[2]).toMatchObject({ uid: 4_000_000, gid: 70 });
    expect(entries[3]!.linkname).toBe(`../${"x".repeat(150)}`);
  });

  it("refuses content that does not match the declared size", async () => {
    await expect(
      pack(async (writer) => {
        await writer.file({ name: "a", size: 10, mode: 0o600, mtime: 0 }, Buffer.from("short"));
      }),
    ).rejects.toThrow(TarError);
  });

  it("detects corruption and truncation", async () => {
    const archive = await pack(async (writer) => {
      await writer.file({ name: "a.txt", size: 600, mode: 0o600, mtime: 0 }, Buffer.alloc(600, 1));
    });
    const corrupt = Buffer.from(archive);
    corrupt[10] = 0x41;
    await expect(collect(corrupt)).rejects.toThrow(/checksum/);
    await expect(collect(archive.subarray(0, 900))).rejects.toThrow(/truncated/);
    await expect(collect(archive.subarray(0, 512 + 1024))).rejects.toThrow(/end marker/);
  });

  it("skips unread content and reports special entries", async () => {
    const archive = await pack(async (writer) => {
      await writer.file({ name: "big", size: 2000, mode: 0o600, mtime: 0 }, Buffer.alloc(2000, 7));
      await writer.file({ name: "small", size: 2, mode: 0o600, mtime: 0 }, Buffer.from("ok"));
    });
    const names: string[] = [];
    for await (const entry of readTar([archive])) {
      names.push(entry.name);
      if (entry.name === "small") {
        for await (const chunk of entry.content) expect(chunk.toString()).toBe("ok");
      }
    }
    expect(names).toEqual(["big", "small"]);
  });

  it("stops writing when the output goes away instead of waiting forever", async () => {
    const output = new PassThrough({ highWaterMark: 1024 });
    const writer = new TarWriter(sinkTo(output));
    const writing = writer.file(
      { name: "big", size: 1024 * 1024, mode: 0o600, mtime: 0 },
      Buffer.alloc(1024 * 1024),
    );
    setTimeout(() => output.destroy(), 10);
    await expect(writing).rejects.toThrow(TarError);
    await expect(
      writer.file({ name: "x", size: 1, mode: 0o600, mtime: 0 }, Buffer.from("x")),
    ).rejects.toThrow(TarError);
  });

  it("normalizes safe member names and rejects escaping ones", () => {
    expect(safeRelativePath("data/x/y")).toBe("data/x/y");
    for (const bad of ["", "/etc/passwd", "data/../x", "./data", "data//x", "a\0b"])
      expect(safeRelativePath(bad)).toBeNull();
  });

  it.skipIf(!hasTar)("interoperates with the system tar", async () => {
    temp = mkdtempSync(join(tmpdir(), "otuken-tar-"));
    const deep = `${"klasör-".repeat(20)}/${"b".repeat(120)}`;
    mkdirSync(join(temp, "src", "data", deep), { recursive: true });
    writeFileSync(join(temp, "src", "data", deep, "f.txt"), "sistem");
    symlinkSync("f.txt", join(temp, "src", "data", deep, "l"));
    execFileSync("tar", ["-cf", join(temp, "system.tar"), "-C", join(temp, "src"), "data"]);
    const entries = await collect(readFileSync(join(temp, "system.tar")));
    expect(entries.find((e) => e.name === `data/${deep}/f.txt`)?.text).toBe("sistem");
    expect(entries.find((e) => e.name === `data/${deep}/l`)).toMatchObject({
      type: "symlink",
      linkname: "f.txt",
    });

    // And the system tar reads what we write.
    const ours = await pack(async (writer) => {
      await writer.directory({ name: "out", mode: 0o755, mtime: 0 });
      await writer.file(
        { name: `out/${"d".repeat(130)}/z.txt`, size: 4, mode: 0o644, mtime: 0 },
        Buffer.from("otkn"),
      );
    });
    writeFileSync(join(temp, "ours.tar"), ours);
    mkdirSync(join(temp, "x"));
    execFileSync("tar", ["-xf", join(temp, "ours.tar"), "-C", join(temp, "x")]);
    expect(readFileSync(join(temp, "x", "out", "d".repeat(130), "z.txt"), "utf8")).toBe("otkn");
  });
});
