import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_RUNTIME_CSP } from "@everyos/app-manifest";
import { contentTypeOf, keyFingerprint, packDirectory } from "@everyos/app-package";
import { build as esbuild } from "esbuild";
import { watch } from "./build.ts";
import type { Project } from "./project.ts";
import { initRegistry, publishPackage, type RegistryPaths } from "./registry.ts";
import { validateBuild, type Finding } from "./validate.ts";

/** Command output (a CLI prints; the rest of EveryOS logs). */
const say = (text: unknown) => process.stdout.write(`${String(text)}\n`);

/*
 * `everyos-app dev`: rebuilds on every change and serves
 * - a developer page running the app in EveryOS's sandbox against a MOCK desktop (`/`), and
 * - with `registry`, a signed development registry (`/registry/index.json`) a real EveryOS can
 *   add as a private source, so the app runs on EveryOS with nothing bypassed.
 */

const here = dirname(fileURLToPath(import.meta.url));

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EveryOS developer host (MOCK)</title>
<style>
:root { color-scheme: light dark; --bg: #f4f5f8; --panel: #fff; --fg: #16181d; --muted: #5d6270; --line: #d9dde5; --warn: #b45309; --err: #b91c1c; --ok: #15803d; }
:root[data-theme="dark"] { --bg: #111318; --panel: #1b1e25; --fg: #eceef3; --muted: #9ca2b0; --line: #333844; --warn: #f59e0b; --err: #f87171; --ok: #4ade80; }
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: grid; grid-template: auto 1fr / 260px 1fr 320px; height: 100vh; }
header { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.mock { background: #f59e0b; color: #1c1300; font-weight: 700; padding: 2px 8px; border-radius: 99px; font-size: 11px; letter-spacing: .04em; }
aside { overflow: auto; padding: 12px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 12px; }
aside.right { border-right: 0; border-left: 1px solid var(--line); }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 4px; }
label { display: block; }
ul { margin: 0; padding-left: 16px; }
li.error { color: var(--err); } li.warning { color: var(--warn); } li.ok { color: var(--ok); }
#stage { display: grid; place-items: center; overflow: auto; padding: 16px; }
iframe { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); width: 900px; height: 640px; max-width: 100%; }
iframe.widget { width: 340px; height: 200px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
dialog.picker { min-width: 360px; } dialog .list { max-height: 50vh; overflow: auto; margin: 8px 0; }
</style>
</head>
<body>
<header><strong>EveryOS developer host</strong><span class="mock">MOCK · NOT EVERYOS</span><span id="app-name"></span>
<span style="margin-left:auto;color:var(--muted)">Real test: <code>everyos-app dev --registry</code> and add the source in EveryOS</span></header>
<aside>
<section><h2>Show</h2><select id="instance"></select> <button id="reload" type="button">Reload</button></section>
<section><h2>Theme</h2><select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></section>
<section><h2>Language</h2><select id="locale"></select></section>
<section><h2>Granted (simulated)</h2><div id="permissions"></div></section>
<section><h2>Files the person has</h2><input id="add-files" type="file" multiple /><ul id="files"></ul></section>
</aside>
<main id="stage"></main>
<aside class="right">
<section><h2>Validation</h2><ul id="findings"></ul></section>
<section><h2>Calls</h2><ul id="calls"></ul></section>
<section><h2>Notifications</h2><ul id="notifications"></ul></section>
<section><h2>Clipboard</h2><ul id="clipboard"></ul></section>
<section><h2>Storage</h2><pre id="storage"></pre></section>
</aside>
<script type="module" src="/__everyos/host.js"></script>
</body>
</html>`;

/** The developer page's script: prebuilt next to a packaged CLI, built from source otherwise. */
async function hostScript(): Promise<string> {
  const prebuilt = join(here, "dev-host.js");
  if (existsSync(prebuilt)) return readFile(prebuilt, "utf8");
  const result = await esbuild({
    entryPoints: [join(here, "dev-host", "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

/** A file under `root` for a URL path, never outside it. */
function within(root: string, urlPath: string): string | null {
  const path = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  if (path.split(/[/\\]/).includes("..")) return null;
  return join(root, path);
}

async function serveFile(response: ServerResponse, file: string | null, csp: boolean) {
  const info = file ? await stat(file).catch(() => null) : null;
  const type = file ? contentTypeOf(file) : null;
  if (!file || !info?.isFile() || !type) {
    response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(csp
      ? {
          "Content-Security-Policy": APP_RUNTIME_CSP,
          "Cross-Origin-Resource-Policy": "cross-origin",
          // Module scripts from the frame's opaque origin are CORS requests, as on EveryOS.
          "Access-Control-Allow-Origin": "*",
        }
      : {}),
  });
  response.end(await readFile(file));
}

export interface DevServer {
  url: string;
  registry: { url: string; publicKey: string; fingerprint: string } | null;
  close(): Promise<void>;
}

export async function dev(
  project: Project,
  options: { port?: number; host?: string; registry?: boolean; log?: (line: string) => void } = {},
): Promise<DevServer> {
  const log = options.log ?? ((line: string) => say(line));
  const work = join(project.root, ".everyos", "dev");
  const outDir = join(work, "app");
  const paths: RegistryPaths = {
    dir: join(work, "registry"),
    key: join(work, "keys", "registry.key"),
    publisherKey: join(work, "keys", "publisher.key"),
  };
  const version = project.manifest.version;
  const baseVersion = (typeof version === "string" ? version : "0.0.0").replace(/-.*$/, "");
  let devVersion = `${baseVersion}-dev.${Date.now()}`;
  const state: {
    manifest: unknown;
    findings: Finding[];
    build: { ok: boolean; error: string | null; at: number };
  } = { manifest: null, findings: [], build: { ok: false, error: null, at: 0 } };
  const clients = new Set<ServerResponse>();
  let registry: DevServer["registry"] = null;
  let publishing = Promise.resolve();
  let built: () => void = () => undefined;
  const firstBuild = new Promise<void>((resolve) => (built = resolve));

  const onBuild = (error: Error | null) => {
    void (async () => {
      state.build = { ok: !error, error: error?.message ?? null, at: Date.now() };
      if (!error) {
        const result = await validateBuild(outDir);
        state.manifest = result.manifest;
        state.findings = result.findings;
        for (const finding of result.findings.filter((entry) => entry.level === "error"))
          log(`✖ ${finding.file}: ${finding.message}`);
        if (
          options.registry &&
          result.manifest &&
          !result.findings.some((f) => f.level === "error")
        )
          publishing = publishing.then(() => publishDev(result.manifest!.icon));
      } else log(`✖ build: ${error.message}`);
      await publishing;
      for (const client of clients) client.write(`event: build\ndata: ${state.build.at}\n\n`);
      built();
    })();
  };

  const publishDev = async (icon: string) => {
    try {
      if (!existsSync(join(paths.dir, "index.json"))) {
        const manifest = project.manifest as {
          name?: string;
          publisher?: { id?: string; name?: string };
        };
        await initRegistry(paths, {
          id: "dev",
          name: `${String(manifest.name ?? "App")} (development)`.slice(0, 64),
          publisherId: String(manifest.publisher?.id ?? ""),
          publisherName: String(manifest.publisher?.name ?? "Developer").slice(0, 64),
        });
      }
      const { bytes } = await packDirectory(outDir);
      const file = join(work, `package.eosapp`);
      await writeFile(file, bytes);
      const published = await publishPackage(paths, file, { iconFile: join(outDir, icon) });
      log(`↑ published ${published.appId} ${published.version} to the development registry`);
      // The next build is a newer version.
      devVersion = `${baseVersion}-dev.${Date.now()}`;
    } catch (error) {
      log(`✖ development registry: ${(error as Error).message}`);
    }
  };

  const script = await hostScript();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(PAGE);
    } else if (url.pathname === "/__everyos/host.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(script);
    } else if (url.pathname === "/__everyos/state") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(state));
    } else if (url.pathname === "/__everyos/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
    } else if (url.pathname.startsWith("/app/"))
      void serveFile(response, within(outDir, url.pathname.slice(5)), true);
    else if (options.registry && url.pathname.startsWith("/registry/"))
      void serveFile(response, within(paths.dir, url.pathname.slice(10)), false);
    else response.writeHead(404).end();
  });
  server.listen(options.port ?? 5180, options.host ?? "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const shown = options.host && options.host !== "0.0.0.0" ? options.host : "127.0.0.1";
  const base = `http://${shown}:${address.port}`;
  const stop = await watch(project, outDir, onBuild, {
    ...(options.registry ? { version: () => devVersion } : {}),
  });
  await firstBuild;
  if (options.registry) {
    const publicKey = existsSync(paths.key.replace(/\.key$/, ".pub"))
      ? await readFile(paths.key.replace(/\.key$/, ".pub"), "utf8")
      : "";
    registry = publicKey
      ? { url: `${base}/registry/index.json`, publicKey, fingerprint: keyFingerprint(publicKey) }
      : null;
  }
  return {
    url: base,
    get registry() {
      return registry;
    },
    async close() {
      await stop();
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
