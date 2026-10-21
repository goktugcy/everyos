import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build as esbuild, context, type BuildOptions, type Plugin } from "esbuild";
import type { Project } from "./project.ts";

export interface BuildOptionsCli {
  /** Default: the project's `outDir`. */
  outDir?: string;
  /** Development build: not minified, with source maps. */
  dev?: boolean;
  /** Written into the built manifest instead of the project's (development versions). */
  version?: string;
}

const entryPoints = (outputs: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(outputs).map(([output, source]) => [output.replace(/\.js$/, ""), source]),
  );

/**
 * What esbuild should do for the project's entries: ES modules that share code through chunks
 * (`chunks/`), loaded on demand by dynamic `import()`.
 */
function esbuildOptions(project: Project, outDir: string, dev: boolean): BuildOptions {
  return {
    absWorkingDir: project.root,
    entryPoints: entryPoints(project.config.entries),
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    minify: !dev,
    sourcemap: dev ? "linked" : false,
    jsx: "automatic",
    loader: {
      ".png": "file",
      ".svg": "file",
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".webp": "file",
    },
    assetNames: "assets/[name]-[hash]",
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    logLevel: "silent",
    metafile: true,
  };
}

/** Workers: one self-contained module each (a worker from a blob URL cannot load chunks). */
function workerOptions(project: Project, outDir: string, dev: boolean): BuildOptions {
  return {
    ...esbuildOptions(project, outDir, dev),
    entryPoints: entryPoints(project.config.workers),
    splitting: false,
    metafile: false,
  };
}

/** Copies the static files and writes the manifest next to the bundles. */
async function copyStatic(project: Project, outDir: string, version?: string): Promise<void> {
  const publicDir = join(project.root, project.config.publicDir);
  if (existsSync(publicDir))
    await cp(publicDir, outDir, {
      recursive: true,
      filter: (source) => !source.split("/").at(-1)!.startsWith("."),
    });
  // Read again: in watch mode the manifest may have changed since the project was loaded.
  const current = JSON.parse(await readFile(join(project.root, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const manifest = version ? { ...current, version } : current;
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A clean build of the package's files into `outDir`. */
export async function build(project: Project, options: BuildOptionsCli = {}): Promise<string> {
  const outDir = join(project.root, options.outDir ?? project.config.outDir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const builds = [
    Object.keys(project.config.entries).length &&
      esbuildOptions(project, outDir, options.dev ?? false),
    Object.keys(project.config.workers).length &&
      workerOptions(project, outDir, options.dev ?? false),
  ].filter((entry): entry is BuildOptions => entry !== 0);
  for (const buildOptions of builds) {
    await esbuild(buildOptions).catch(
      (
        error: Error & {
          errors?: Array<{ text: string; location?: { file: string; line: number } }>;
        },
      ) => {
        const first = error.errors?.[0];
        throw new Error(
          first
            ? `${first.location ? `${first.location.file}:${first.location.line}: ` : ""}${first.text}`
            : error instanceof Error
              ? error.message
              : "The build failed",
        );
      },
    );
  }
  await copyStatic(project, outDir, options.version);
  return outDir;
}

/**
 * Rebuilds on every change of the sources or the static files and calls `onBuild` after each
 * build (with the error, when one failed). Returns a function that stops watching.
 */
export async function watch(
  project: Project,
  outDir: string,
  onBuild: (error: Error | null) => void,
  options: { version?: () => string } = {},
): Promise<() => Promise<void>> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const reporter: Plugin = {
    name: "everyos-rebuild",
    setup(builder) {
      builder.onEnd(async (result) => {
        try {
          await copyStatic(project, outDir, options.version?.());
          onBuild(result.errors.length ? new Error(result.errors[0]!.text) : null);
        } catch (error) {
          onBuild(error as Error);
        }
      });
    },
  };
  const ctx = await context({ ...esbuildOptions(project, outDir, true), plugins: [reporter] });
  await ctx.watch();
  const workers = Object.keys(project.config.workers).length
    ? await context(workerOptions(project, outDir, true))
    : null;
  await workers?.watch();
  // Static files are not part of the module graph: watch them too.
  const { watch: watchFiles } = await import("node:fs");
  const watchers = [project.config.publicDir, "manifest.json"]
    .map((path) => join(project.root, path))
    .filter((path) => existsSync(path))
    .map((path) =>
      watchFiles(path, { recursive: true }, () => {
        void ctx.rebuild().catch(() => undefined);
      }),
    );
  return async () => {
    for (const watcher of watchers) watcher.close();
    await ctx.dispose();
    await workers?.dispose();
  };
}
