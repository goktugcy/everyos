import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPackagePath } from "@everyos/app-manifest";
import { contentTypeOf } from "@everyos/app-package";

/*
 * An app project: `manifest.json` at its root, static files in `public/`, code in `src/`, and an
 * optional `everyos.config.json` that changes those defaults.
 */

export interface ProjectConfig {
  /** Output file (relative to the package root) → source entry. */
  entries: Record<string, string>;
  /**
   * Output file → source of a Web Worker: bundled into one self-contained file (no shared chunks),
   * as a worker started from a blob URL in the app's opaque origin needs.
   */
  workers: Record<string, string>;
  /**
   * Package path → file or folder in the project (often a dependency's, such as
   * `node_modules/pdfjs-dist/cmaps`), copied in at build time instead of being kept in `public/`.
   */
  assets: Record<string, string>;
  publicDir: string;
  outDir: string;
  /** Your own registry (`everyos-app publish`): its directory and the keys that sign it. */
  registry: { dir: string; key: string; publisherKey: string };
}

export interface Project {
  root: string;
  config: ProjectConfig;
  /** The manifest as written (validated by `validate`). */
  manifest: Record<string, unknown>;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`${what} not found: ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(`${what} is not valid JSON (${(error as Error).message})`);
  }
}

export async function loadProject(root = process.cwd()): Promise<Project> {
  const dir = resolve(root);
  const manifest = await readJson(join(dir, "manifest.json"), "manifest.json");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new CliError("manifest.json must hold an object");
  const configured = existsSync(join(dir, "everyos.config.json"))
    ? ((await readJson(join(dir, "everyos.config.json"), "everyos.config.json")) as Partial<
        Omit<ProjectConfig, "registry">
      > & { registry?: Partial<ProjectConfig["registry"]> })
    : {};
  const main = ["src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js"].find((file) =>
    existsSync(join(dir, file)),
  );
  const entries = configured.entries ?? (main ? { "app.js": main } : {});
  const workers = configured.workers ?? {};
  for (const [output, source] of [...Object.entries(entries), ...Object.entries(workers)]) {
    if (!/^(?!\/)(?!.*\.\.)[\w./-]+\.js$/.test(output))
      throw new CliError(`Entry output "${output}" must be a relative path ending in .js`);
    if (!existsSync(join(dir, source))) throw new CliError(`Entry source not found: ${source}`);
  }
  const assets = configured.assets ?? {};
  for (const [output, source] of Object.entries(assets)) {
    if (!isPackagePath(output.replace(/\/$/, "")))
      throw new CliError(`Asset path "${output}" must be a relative package path`);
    if (source.split(/[\\/]/).includes("..") || source.startsWith("/"))
      throw new CliError(`Asset source "${source}" must be inside the project`);
    if (!existsSync(join(dir, source))) throw new CliError(`Asset source not found: ${source}`);
    if (!statSync(join(dir, source)).isDirectory() && !contentTypeOf(source))
      throw new CliError(`Asset "${source}": EveryOS does not serve this type of file`);
  }
  return {
    root: dir,
    manifest: manifest as Record<string, unknown>,
    config: {
      entries,
      workers,
      assets,
      publicDir: configured.publicDir ?? "public",
      outDir: configured.outDir ?? "dist",
      registry: {
        dir: configured.registry?.dir ?? "registry",
        key: configured.registry?.key ?? "keys/registry.key",
        publisherKey: configured.registry?.publisherKey ?? "keys/publisher.key",
      },
    },
  };
}
