/**
 * Production build: bundles the API and the agent into single ESM files with
 * esbuild and stages the web client next to them.
 *
 *   dist/
 *     api/server.mjs     Otuken API (runs as the `otuken` user)
 *     agent/agent.mjs    privileged agent
 *     web/               static web client (+ .br/.gz siblings)
 *
 * Otuken has no native Node addons, so the same output runs on ARM64 and
 * AMD64; packaging only needs to add the matching Node.js runtime.
 * Run `pnpm build` (it builds the web client first).
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const webDist = join(root, "apps/web/dist");

if (!existsSync(join(webDist, "index.html"))) {
  console.error(
    "Web client is not built. Run `pnpm --filter @otuken/web build` first (or `pnpm build`).",
  );
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

const banner =
  "import { createRequire as __otukenCreateRequire } from 'node:module';" +
  "const require = __otukenCreateRequire(import.meta.url);";

async function bundle(entry: string, outfile: string): Promise<void> {
  const result = await build({
    entryPoints: [join(root, entry)],
    outfile: join(dist, outfile),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    minify: false,
    sourcemap: "linked",
    legalComments: "linked",
    banner: { js: banner },
    metafile: true,
    logLevel: "warning",
  });
  const bytes = Object.values(result.metafile.outputs).reduce(
    (sum, output) => sum + output.bytes,
    0,
  );
  console.log(`  ${outfile.padEnd(20)} ${(bytes / 1024).toFixed(0)} KiB`);
}

console.log("Bundling server components…");
await bundle("apps/api/src/main.ts", "api/server.mjs");
await bundle("apps/agent/src/main.ts", "agent/agent.mjs");

console.log("Staging web client…");
cpSync(webDist, join(dist, "web"), { recursive: true });

// Pre-compress text assets once at build time so the server never spends CPU on it.
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);
let compressed = 0;
function precompress(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      precompress(path);
      continue;
    }
    if (!COMPRESSIBLE.has(extname(name)) || statSync(path).size < 1024) continue;
    const content = readFileSync(path);
    writeFileSync(
      `${path}.br`,
      brotliCompressSync(content, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
    );
    writeFileSync(`${path}.gz`, gzipSync(content, { level: 9 }));
    compressed++;
  }
}
precompress(join(dist, "web"));
console.log(`  pre-compressed ${compressed} assets`);

const version = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
).version;
writeFileSync(join(dist, "VERSION"), `${version}\n`);
console.log(`Done: dist/ (Otuken ${version})`);
