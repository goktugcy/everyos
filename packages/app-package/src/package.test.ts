import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { generateKeyPairSync } from "node:crypto";
import { TarWriter } from "@everyos/system/archive";
import { describe, expect, it } from "vitest";
import {
  extractPackage,
  generatePublisherKeys,
  inspectPackage,
  keyFingerprint,
  PACKAGE_LIMITS,
  packDirectory,
  PackageError,
  sha256Hex,
  signPackage,
  verifyPackage,
} from "./index.ts";

const MANIFEST = {
  manifestVersion: 1,
  id: "io.github.alice.todo",
  name: "To-Do",
  version: "1.2.0",
  description: "Tasks",
  entry: "index.html",
  icon: "icon.png",
  category: "productivity",
  permissions: ["storage:app"],
  window: {
    defaultWidth: 800,
    defaultHeight: 600,
    minWidth: 400,
    minHeight: 300,
    instances: "single",
  },
  widgets: [],
  locales: { default: "en", supported: ["en", "tr"], path: "locales" },
  sdk: "^1.0.0",
  publisher: { id: "io.github.alice", name: "Alice" },
};

async function buildDir(files: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eosapp-build-"));
  const all: Record<string, string | Buffer> = {
    "manifest.json": JSON.stringify(MANIFEST),
    "index.html": "<!doctype html><script type=module src=assets/app.js></script>",
    "icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "assets/app.js": "console.log(1)",
    "locales/en.json": "{}",
    "locales/tr.json": "{}",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

type Entry =
  | { name: string; type: "file"; content: Buffer | string }
  | { name: string; type: "directory" }
  | { name: string; type: "symlink"; linkname: string };

async function tarGz(entries: Entry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const writer = new TarWriter((chunk) => {
    chunks.push(chunk);
    return Promise.resolve();
  });
  for (const entry of entries) {
    if (entry.type === "file") {
      const content = Buffer.from(entry.content);
      await writer.file({ name: entry.name, mode: 0o755, mtime: 0, size: content.length }, content);
    } else if (entry.type === "directory")
      await writer.directory({ name: entry.name, mode: 0o755, mtime: 0 });
    else
      await writer.symlink({ name: entry.name, mode: 0o777, mtime: 0, linkname: entry.linkname });
  }
  await writer.end();
  return gzipSync(Buffer.concat(chunks));
}

const valid = (): Entry[] => [
  { name: "manifest.json", type: "file", content: JSON.stringify(MANIFEST) },
  { name: "index.html", type: "file", content: "<!doctype html>" },
  { name: "icon.png", type: "file", content: "png" },
  { name: "locales/en.json", type: "file", content: "{}" },
  { name: "locales/tr.json", type: "file", content: "{}" },
];

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof PackageError) return error.code;
    throw error;
  }
}

describe(".eosapp packages", () => {
  it("packs deterministically, inspects and extracts without executable bits", async () => {
    const dir = await buildDir();
    const first = await packDirectory(dir);
    const second = await packDirectory(dir);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.files).toEqual([
      "assets/app.js",
      "icon.png",
      "index.html",
      "locales/en.json",
      "locales/tr.json",
      "manifest.json",
    ]);
    const inspected = await inspectPackage(first.bytes);
    expect(inspected.manifest.id).toBe("io.github.alice.todo");
    expect(inspected.files.find((file) => file.path === "assets/app.js")?.size).toBe(14);

    const target = join(await mkdtemp(join(tmpdir(), "eosapp-out-")), "app");
    const extracted = await extractPackage(first.bytes, target);
    expect(extracted.files).toEqual(first.files);
    expect(await readFile(join(target, "assets/app.js"), "utf8")).toBe("console.log(1)");
    expect((await stat(join(target, "assets/app.js"))).mode & 0o777).toBe(0o644);
  });

  it("refuses to pack links, unknown file types and incomplete apps", async () => {
    const linked = await buildDir();
    await symlink("/etc/passwd", join(linked, "assets/passwd.txt"));
    expect(await code(packDirectory(linked))).toBe("unsafe-entry");
    expect(await code(packDirectory(await buildDir({ "install.sh": "rm -rf /" })))).toBe(
      "unsupported-file",
    );
    const noLocale = await buildDir();
    await writeFile(
      join(noLocale, "manifest.json"),
      JSON.stringify({ ...MANIFEST, icon: "x.png" }),
    );
    expect(await code(packDirectory(noLocale))).toBe("missing-file");
    const badManifest = await buildDir({ "manifest.json": "{" });
    expect(await code(packDirectory(badManifest))).toBe("invalid-manifest");
    // Hidden files are build-machine droppings, not app content.
    const hidden = await packDirectory(await buildDir({ ".DS_Store": "x" }));
    expect(hidden.files).not.toContain(".DS_Store");
  });

  it("refuses entries that escape, links, duplicates and foreign files, leaving nothing behind", async () => {
    const cases: Array<[Entry[], string]> = [
      [[...valid(), { name: "../evil.js", type: "file", content: "x" }], "unsafe-entry"],
      [[...valid(), { name: "/etc/evil.js", type: "file", content: "x" }], "unsafe-entry"],
      [[...valid(), { name: "assets/../../evil.js", type: "file", content: "x" }], "unsafe-entry"],
      [
        [...valid(), { name: "assets/link.js", type: "symlink", linkname: "/etc/passwd" }],
        "unsafe-entry",
      ],
      [
        [
          ...valid(),
          { name: "App.js", type: "file", content: "1" },
          { name: "app.js", type: "file", content: "2" },
        ],
        "duplicate-entry",
      ],
      [[...valid(), { name: "tool.exe", type: "file", content: "MZ" }], "unsupported-file"],
      [valid().filter((entry) => entry.name !== "manifest.json"), "missing-manifest"],
      [valid().filter((entry) => entry.name !== "locales/tr.json"), "missing-file"],
    ];
    for (const [entries, expected] of cases) {
      const target = join(await mkdtemp(join(tmpdir(), "eosapp-bad-")), "app");
      expect(await code(extractPackage(await tarGz(entries), target)), expected).toBe(expected);
      expect(existsSync(target), expected).toBe(false);
    }
  });

  it("stops archive bombs, oversized packages and corrupt data", async () => {
    const limits = { ...PACKAGE_LIMITS, unpackedBytes: 1024 * 1024 };
    const bomb = await tarGz([
      ...valid(),
      { name: "assets/zeros.txt", type: "file", content: Buffer.alloc(8 * 1024 * 1024) },
    ]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(await code(inspectPackage(bomb, limits))).toBe("too-large");
    const many = await tarGz([
      ...valid(),
      ...Array.from({ length: 20 }, (_, i): Entry => ({
        name: `f${i}.txt`,
        type: "file",
        content: "",
      })),
    ]);
    expect(await code(inspectPackage(many, { ...PACKAGE_LIMITS, entries: 10 }))).toBe("too-large");
    expect(await code(inspectPackage(Buffer.alloc(2048, 7)))).toBe("corrupt");
    const package_ = await tarGz(valid());
    expect(await code(inspectPackage(package_.subarray(0, package_.length - 40)))).toBe("corrupt");
    expect(
      await code(inspectPackage(package_, { ...PACKAGE_LIMITS, packedBytes: package_.length - 1 })),
    ).toBe("too-large");
  });
});

describe("publisher signatures", () => {
  it("verifies exactly what was signed, with the publisher's key only", () => {
    const keys = generatePublisherKeys();
    const bytes = Buffer.from("package bytes");
    const digest = {
      appId: "io.github.alice.todo",
      version: "1.2.0",
      sha256: sha256Hex(bytes),
      size: bytes.length,
    };
    const signature = signPackage(digest, keys.privateKey);
    expect(verifyPackage(digest, signature, keys.publicKey)).toBe(true);
    expect(verifyPackage({ ...digest, version: "1.2.1" }, signature, keys.publicKey)).toBe(false);
    expect(verifyPackage({ ...digest, size: digest.size + 1 }, signature, keys.publicKey)).toBe(
      false,
    );
    expect(verifyPackage(digest, signature, generatePublisherKeys().publicKey)).toBe(false);
    expect(verifyPackage(digest, `${signature.slice(0, -4)}AAA=`, keys.publicKey)).toBe(false);
    expect(keyFingerprint(keys.publicKey)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(() => verifyPackage(digest, signature, rsa)).toThrow(/Ed25519/);
  });
});
