import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import ts from "typescript";
import { z } from "zod";
import { TarWriter } from "../packages/system/src/archive/index.ts";

const exec = promisify(execFile);
interface PackageMeta {
  name: string;
  version: string;
  description?: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
}
interface Definition {
  slug: string;
  entries: Record<string, string>;
  bin?: string;
  external: string[];
  node: boolean;
}
export const SDK_PACKAGES: readonly Definition[] = [
  {
    slug: "app-sdk",
    entries: { index: "src/index.ts", protocol: "src/protocol.ts" },
    external: [],
    node: false,
  },
  {
    slug: "app-testing",
    entries: { index: "src/index.ts", dom: "src/dom.ts", setup: "src/setup.ts" },
    external: ["@everyos/app-sdk"],
    node: false,
  },
  {
    slug: "app-ui",
    entries: {
      index: "src/index.ts",
      markdown: "src/markdown.ts",
      testing: "src/testing.ts",
      editor: "src/editor.tsx",
    },
    external: ["@everyos/app-sdk", "@everyos/app-testing"],
    node: false,
  },
  {
    slug: "app-cli",
    entries: { index: "src/index.ts", cli: "src/cli.ts" },
    bin: "everyos-app",
    external: ["esbuild", "zod"],
    node: true,
  },
  {
    slug: "create-everyos-app",
    entries: { create: "src/create.ts", cli: "src/cli.ts" },
    bin: "create-everyos-app",
    external: [],
    node: true,
  },
];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const safeVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
export const SdkReport = z.strictObject({
  format: z.literal("everyos-sdk-distribution/1"),
  source: z.strictObject({
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    everyosVersion: safeVersion,
  }),
  sdkVersion: safeVersion,
  packages: z
    .array(
      z.strictObject({
        name: z.string(),
        version: safeVersion,
        file: z.string().regex(/^[a-z0-9][a-z0-9.-]+\.tgz$/),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
      }),
    )
    .length(5),
});
export type SdkReport = z.infer<typeof SdkReport>;
const meta = async (path: string) => JSON.parse(await readFile(path, "utf8")) as PackageMeta;
const fileOf = (name: string, version: string) =>
  `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
const declarationsOf = (path: string) => path.replace(/\.tsx?$/, ".d.ts");
async function filesOf(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await filesOf(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Package files cannot contain links: ${path}`);
  }
  return result.sort();
}
async function emitDeclarations(root: string, out: string): Promise<void> {
  const roots: string[] = [];
  for (const item of SDK_PACKAGES)
    roots.push(
      ...(await filesOf(join(root, "packages", item.slug, "src"))).filter(
        (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
      ),
    );
  const config = ts.readConfigFile(join(root, "tsconfig.base.json"), (file) =>
    ts.sys.readFile(file),
  );
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const compilerOptions: ts.CompilerOptions = {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: join(root, "packages"),
    outDir: out,
    types: ["node"],
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  const dependencyProgram = ts.createProgram(roots, compilerOptions);
  for (const source of dependencyProgram.getSourceFiles()) {
    const path = realpathSync(source.fileName);
    if (path.startsWith(join(root, "packages") + "/") && !source.isDeclarationFile)
      roots.push(path);
  }
  const program = ts.createProgram([...new Set(roots)], compilerOptions);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  if (program.emit().emitSkipped) throw new Error("SDK declaration emit failed");
  // TypeScript does not copy input ambient declarations during declaration-only emit.
  for (const file of roots.filter((path) => path.endsWith(".d.ts"))) {
    const target = join(out, relative(join(root, "packages"), file));
    await mkdir(dirname(target), { recursive: true });
    await cp(file, target);
  }
}
async function packageTypes(
  root: string,
  declarations: string,
  output: string,
  definition: Definition,
  dependencies: Set<string>,
) {
  const workspace = new Map<string, { slug: string; meta: PackageMeta }>();
  for (const slug of await readdir(join(root, "packages"))) {
    const path = join(root, "packages", slug, "package.json");
    try {
      const pkg = await meta(path);
      workspace.set(pkg.name, { slug, meta: pkg });
    } catch {
      /* Not a package directory. */
    }
  }
  const copied = new Set<string>();
  const copy = async (file: string): Promise<void> => {
    if (copied.has(file)) return;
    copied.add(file);
    const text = await readFile(file, "utf8");
    const target = join(output, "types", relative(declarations, file));
    const edits: Array<{ start: number; end: number; value: string }> = [];
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const spec = imported.fileName;
      let resolved: string | undefined;
      if (spec.startsWith(".")) resolved = declarationsOf(resolve(dirname(file), spec));
      else {
        const pkg = [...workspace].find(([name]) => spec === name || spec.startsWith(name + "/"));
        if (pkg && !dependencies.has(pkg[0])) {
          const subpath = spec === pkg[0] ? "." : "." + spec.slice(pkg[0].length);
          const exported = pkg[1].meta.exports?.[subpath];
          if (!exported) throw new Error(`No type export for bundled dependency ${spec}`);
          resolved = join(declarations, pkg[1].slug, declarationsOf(exported));
        } else if (!spec.startsWith("node:")) {
          const name = spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0]!;
          if (!dependencies.has(name))
            throw new Error(`Undeclared public type dependency ${spec} in ${file}`);
        }
      }
      if (resolved) {
        if (relative(declarations, resolved).startsWith(".."))
          throw new Error("Type declaration escaped the package closure");
        await copy(resolved);
        const copiedTarget = join(output, "types", relative(declarations, resolved));
        const path = relative(dirname(target), copiedTarget)
          .split("\\")
          .join("/")
          .replace(/\.d\.ts$/, ".js");
        edits.push({
          start: imported.pos + 1,
          end: imported.end + 1,
          value: path.startsWith(".") ? path : "./" + path,
        });
      }
    }
    let rewritten = text;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewritten);
  };
  for (const entry of Object.values(definition.entries))
    await copy(join(declarations, definition.slug, declarationsOf(entry)));
}
async function archive(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const writer = new TarWriter((chunk) => {
    chunks.push(chunk);
    return Promise.resolve();
  });
  for (const file of await filesOf(dir)) {
    const bytes = await readFile(file);
    await writer.file(
      {
        name: "package/" + relative(dir, file).split("\\").join("/"),
        mode: (await stat(file)).mode & 0o111 ? 0o755 : 0o644,
        mtime: 0,
        size: bytes.length,
      },
      bytes,
    );
  }
  await writer.end();
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Build real npm-compatible archives; no workspace/private dependency survives in a published manifest. */
export async function buildSdkDistribution(root: string, out: string): Promise<SdkReport> {
  if (!isAbsolute(out) || relative(root, out) === "" || !relative(root, out).startsWith("dist/"))
    throw new Error("SDK output must be a subdirectory of dist/");
  const scratch = await mkdtemp(join(tmpdir(), "everyos-sdk-build-"));
  try {
    const declarations = join(scratch, "declarations");
    await emitDeclarations(root, declarations);
    await mkdir(out, { recursive: true });
    const result: SdkReport["packages"] = [];
    for (const item of SDK_PACKAGES) {
      const source = join(root, "packages", item.slug),
        pkg = await meta(join(source, "package.json"));
      const version = safeVersion.parse(pkg.version);
      const stage = join(scratch, item.slug);
      await mkdir(stage);
      const runtime: Record<string, string> = {};
      const peers = pkg.peerDependencies ?? {};
      if (item.slug === "app-cli") {
        runtime.esbuild = (await meta(join(root, "node_modules/esbuild/package.json"))).version;
        runtime.zod = (await meta(join(root, "node_modules/zod/package.json"))).version;
      } else if (item.slug === "app-ui") {
        for (const name of Object.keys(pkg.dependencies ?? {}))
          runtime[name] = (await meta(join(source, "node_modules", name, "package.json"))).version;
      }
      const external = [...item.external, ...Object.keys(runtime), ...Object.keys(peers)];
      const built = await build({
        absWorkingDir: source,
        entryPoints: item.entries,
        outdir: join(stage, "dist"),
        bundle: true,
        format: "esm",
        splitting: true,
        platform: item.node ? "node" : "neutral",
        target: item.node ? "node26" : "es2022",
        outExtension: { ".js": ".mjs" },
        external: [...external, "node:*"],
        jsx: "automatic",
        conditions: ["import", "default"],
        banner: item.node
          ? {
              js: "import { createRequire as __everyosCreateRequire } from 'node:module'; const require = __everyosCreateRequire(import.meta.url);",
            }
          : {},
        legalComments: "linked",
        metafile: true,
        logLevel: "silent",
      });
      if (
        item.slug === "app-sdk" &&
        Object.keys(built.metafile.inputs).some((path) => path.includes("node_modules/"))
      )
        throw new Error("The browser SDK must have zero third-party runtime dependencies");
      if (item.slug === "app-cli") {
        // import.meta.url stays in the shared ESM chunk; keep the prebuilt host beside every output.
        const host = await build({
          entryPoints: [join(source, "src/dev-host/main.ts")],
          bundle: true,
          format: "esm",
          platform: "browser",
          target: "es2022",
          write: false,
          logLevel: "silent",
        });
        await writeFile(join(stage, "dist/dev-host.js"), host.outputFiles[0]!.contents);
      }
      if (item.bin) await chmod(join(stage, "dist/cli.mjs"), 0o755);
      if (item.slug === "create-everyos-app")
        await cp(join(source, "templates"), join(stage, "templates"), { recursive: true });
      if (item.slug === "app-ui")
        await cp(join(source, "src/styles.css"), join(stage, "styles.css"));
      const exports: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(item.entries)) {
        if (name === "cli") continue;
        const key = name === "index" || name === "create" ? "." : "./" + name;
        exports[key] = {
          types: `./types/${item.slug}/${declarationsOf(entry)}`,
          import: `./dist/${name}.mjs`,
        };
      }
      if (item.slug === "app-ui") exports["./styles.css"] = "./styles.css";
      const published = {
        name: pkg.name,
        version,
        description: pkg.description,
        type: "module",
        license: "MIT",
        engines: { node: ">=26.0.0" },
        repository: {
          type: "git",
          url: "https://github.com/goktugcy/everyos.git",
          directory: "packages/" + item.slug,
        },
        exports,
        ...(item.bin ? { bin: { [item.bin]: "./dist/cli.mjs" } } : {}),
        ...(Object.keys(runtime).length ? { dependencies: runtime } : {}),
        ...(Object.keys(peers).length ? { peerDependencies: peers } : {}),
        ...(pkg.peerDependenciesMeta ? { peerDependenciesMeta: pkg.peerDependenciesMeta } : {}),
      };
      await packageTypes(
        root,
        declarations,
        stage,
        item,
        new Set([...Object.keys(runtime), ...Object.keys(peers)]),
      );
      await writeFile(join(stage, "package.json"), JSON.stringify(published, null, 2) + "\n");
      await cp(join(root, "LICENSE"), join(stage, "LICENSE"));
      await writeFile(
        join(stage, "README.md"),
        `# ${pkg.name}\n\n${pkg.description ?? "EveryOS App SDK"}\n\nDocumentation: https://github.com/goktugcy/everyos/tree/main/docs/app-sdk\n\nThe app-testing package and CLI developer host are explicitly simulated desktop environments. Real host permissions are enforced by EveryOS.\n`,
      );
      const bytes = await archive(stage),
        file = fileOf(pkg.name, version);
      await writeFile(join(out, file), bytes);
      result.push({
        name: pkg.name,
        version,
        file,
        size: bytes.length,
        sha256: sha256(bytes),
        integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      });
    }
    const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
    const { stdout: dirty } = await exec(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      { cwd: root },
    );
    const rootPackage = await meta(join(root, "package.json"));
    const report = SdkReport.parse({
      format: "everyos-sdk-distribution/1",
      source: {
        commit: commit.trim(),
        dirty: dirty.trim().length > 0,
        everyosVersion: rootPackage.version,
      },
      sdkVersion: result[0]!.version,
      packages: result,
    });
    await writeFile(join(out, "sdk-report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
const signingPayload = (report: Buffer) =>
  Buffer.concat([Buffer.from("everyos-sdk-distribution/1\0"), report]);

/** Only the protected release job supplies the production key. */
export async function signSdkDistribution(out: string, privatePem: string): Promise<void> {
  await verifySdkDistribution(out);
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 key is required");
  const report = await readFile(join(out, "sdk-report.json"));
  await writeFile(join(out, "sdk-report.sig"), sign(null, signingPayload(report), key));
}

export async function verifySdkDistribution(out: string, publicPem?: string): Promise<SdkReport> {
  const files = await readdir(out, { withFileTypes: true });
  if ((await lstat(out)).isSymbolicLink() || files.some((file) => !file.isFile()))
    throw new Error("SDK distribution must contain regular files without links");
  const reportBytes = await readFile(join(out, "sdk-report.json"));
  if (publicPem !== undefined) {
    const key = createPublicKey(publicPem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(null, signingPayload(reportBytes), key, await readFile(join(out, "sdk-report.sig")))
    )
      throw new Error("Invalid SDK distribution signature");
  }
  const report = SdkReport.parse(JSON.parse(reportBytes.toString("utf8")));
  const names = report.packages.map((pkg) => pkg.name);
  if (
    new Set(names).size !== 5 ||
    SDK_PACKAGES.some(
      (pkg) =>
        !names.includes(pkg.slug === "create-everyos-app" ? pkg.slug : "@everyos/" + pkg.slug),
    )
  )
    throw new Error("Incomplete SDK distribution");
  for (const item of report.packages) {
    const bytes = await readFile(join(out, item.file));
    if (
      item.file !== fileOf(item.name, item.version) ||
      item.version !== report.sdkVersion ||
      bytes.length !== item.size ||
      sha256(bytes) !== item.sha256 ||
      "sha512-" + createHash("sha512").update(bytes).digest("base64") !== item.integrity
    )
      throw new Error(`SDK artifact differs: ${item.name}`);
  }
  if (
    files.some(
      (file) =>
        file.name !== "sdk-report.json" &&
        !(publicPem !== undefined && file.name === "sdk-report.sig") &&
        !report.packages.some((pkg) => pkg.file === file.name),
    )
  )
    throw new Error("Unexpected SDK distribution file");
  return report;
}
