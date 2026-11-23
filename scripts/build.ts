/**
 * Production build: bundles the API and the agent into single ESM files with
 * esbuild and stages the web client next to them.
 *
 *   dist/
 *     api/server.mjs     EveryOS API (runs as the `everyos` user)
 *     agent/agent.mjs    privileged agent
 *     web/               static web client (+ .br/.gz siblings)
 *
 * EveryOS has no native Node addons, so the same output runs on ARM64 and
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
import { createRequire } from "node:module";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const webDist = join(root, "apps/web/dist");

if (!existsSync(join(webDist, "index.html"))) {
  console.error(
    "Web client is not built. Run `pnpm --filter @everyos/web build` first (or `pnpm build`).",
  );
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

const banner =
  "import { createRequire as __everyosCreateRequire } from 'node:module';" +
  "import { fileURLToPath as __everyosFileURLToPath } from 'node:url';" +
  "import { dirname as __everyosDirname } from 'node:path';" +
  "const require = __everyosCreateRequire(import.meta.url);" +
  // CommonJS dependencies can compute helper paths during import (ssh2's unused Windows agent).
  "const __filename = __everyosFileURLToPath(import.meta.url);" +
  "const __dirname = __everyosDirname(__filename);";

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
    // pg's optional native binding: never installed or loaded (EveryOS uses the JavaScript client).
    external: ["pg-native"],
    // ssh2 has a complete Node crypto fallback. Keep the production bundle portable across
    // AMD64/ARM64 instead of probing or shipping build-machine-specific optional native addons.
    plugins: [
      {
        name: "node-crypto-only",
        setup(build) {
          build.onResolve(
            { filter: /^(?:cpu-features|\.\/crypto\/build\/Release\/sshcrypto\.node)$/ },
            () => ({ path: "disabled", namespace: "optional-native" }),
          );
          build.onLoad({ filter: /.*/, namespace: "optional-native" }, () => ({
            contents: 'throw new Error("Optional native acceleration is disabled");',
            loader: "js",
          }));
        },
      },
    ],
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
await bundle("apps/agent/src/account-worker.ts", "agent/account-worker.mjs");
await bundle("apps/agent/src/sudo-witness.ts", "agent/sudo-witness.mjs");
await bundle("packages/release/src/worker.ts", "update/worker.mjs");
await bundle("packages/release/src/cli.ts", "cli/cli.mjs");

// These permissive dependencies ship standalone license files rather than esbuild-recognized
// source banners. Keep their full notices next to the bundled API in the Linux package.
const noticeQueue = [{ from: createRequire(join(root, "apps/api/package.json")), name: "ssh2" }];
const noticeSeen = new Set<string>();
let sshNotices = "Third-party notices for the bundled SSH/SFTP implementation\n";
while (noticeQueue.length) {
  const item = noticeQueue.shift()!;
  const manifest = item.from.resolve(item.name + "/package.json");
  if (noticeSeen.has(manifest)) continue;
  noticeSeen.add(manifest);
  const directory = dirname(manifest);
  const metadata = JSON.parse(readFileSync(manifest, "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  const license = readdirSync(directory).find((name) => /^licen[cs]e(?:\.|$)/i.test(name));
  if (!license) throw new Error("Missing dependency license: " + metadata.name);
  sshNotices +=
    "\n" +
    metadata.name +
    " " +
    metadata.version +
    "\n" +
    readFileSync(join(directory, license), "utf8") +
    "\n";
  for (const name of Object.keys(metadata.dependencies ?? {}))
    noticeQueue.push({ from: createRequire(manifest), name });
}
writeFileSync(join(dist, "api/SSH2-NOTICES.txt"), sshNotices);

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
console.log(`Done: dist/ (EveryOS ${version})`);
