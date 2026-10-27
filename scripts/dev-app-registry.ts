import { execFile } from "node:child_process";
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyRegistryIndex } from "../packages/app-registry/src/index.ts";

const exec = promisify(execFile);

/** Real official packages, with development-only signing keys and a loopback-only transport. */
export async function startDevAppRegistry(root: string, devRoot: string) {
  if (process.getuid?.() === 0) throw new Error("The development registry refuses to run as root");
  const builds = join(devRoot, "official-apps");
  await mkdir(builds, { recursive: true, mode: 0o700 });
  const runRoot = await mkdtemp(join(builds, "run-"));
  const out = join(runRoot, "registry");
  const env = { ...process.env };
  delete env.EVERYOS_APP_REGISTRY_PRIVATE_KEY;
  delete env.EVERYOS_APP_PUBLISHER_PRIVATE_KEY;
  delete env.EVERYOS_RELEASE_PRIVATE_KEY;
  console.log("Building and verifying official apps for the local development registry...");
  try {
    const result = await exec(
      process.execPath,
      [join(root, "scripts/official-apps.ts"), "check", "--out", out],
      { cwd: root, env, timeout: 240_000, maxBuffer: 1024 * 1024 },
    );
    process.stdout.write(result.stdout);
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
  const publicKey = await readFile(join(out, "official-app-registry.pub"), "utf8");
  const bytes = await readFile(join(out, "official-apps.json"));
  const index = verifyRegistryIndex(bytes.toString("utf8"), publicKey, { official: true });
  const files = new Map<string, Buffer>([["/official-apps.json", bytes]]);
  for (const app of index.apps) {
    for (const name of [
      app.icon,
      ...app.screenshots,
      ...app.versions.map((version) => version.package.url),
    ]) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name))
        throw new Error("Development release assets must have flat, local names");
      files.set(`/${name}`, await readFile(join(out, name)));
    }
  }
  const server = createServer((request, response) => {
    const body = files.get(request.url ?? "");
    const method = request.method === "GET" || request.method === "HEAD";
    response.writeHead(!method ? 405 : body ? 200 : 404, {
      "Content-Type":
        extname(request.url ?? "") === ".json"
          ? "application/json"
          : extname(request.url ?? "") === ".png"
            ? "image/png"
            : "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(!method ? { Allow: "GET, HEAD" } : {}),
    });
    response.end(method && request.method !== "HEAD" ? body : undefined);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No development registry port");
  const anchor = {
    url: `http://127.0.0.1:${address.port}/official-apps.json`,
    publicKey,
    allowPrivate: true,
  };
  const anchorFile = join(devRoot, "official-app-registry.json");
  const text = JSON.stringify(anchor, null, 2) + "\n";
  const pending = join(runRoot, "anchor.json");
  try {
    await writeFile(pending, text, { flag: "wx", mode: 0o600 });
    await rename(pending, anchorFile);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
  console.log(`Development official apps: ${index.apps.length} at ${anchor.url}`);
  console.log("Uses ephemeral development keys; production release trust is unchanged.");
  let closed = false;
  return {
    anchor,
    anchorFile,
    ownsAnchor: () => {
      try {
        return readFileSync(anchorFile, "utf8") === text;
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((accept) => {
        server.close(() => accept());
        server.closeAllConnections();
      });
      if (this.ownsAnchor()) await rm(anchorFile, { force: true });
      await rm(runRoot, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const registry = await startDevAppRegistry(
    root,
    process.env.EVERYOS_DEV_ROOT ?? join(root, ".dev"),
  );
  const shutdown = async () => {
    unwatchFile(registry.anchorFile);
    await registry.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  // A new pnpm dev process can take over without leaving this standalone helper behind.
  watchFile(registry.anchorFile, { interval: 1000, persistent: false }, () => {
    if (!registry.ownsAnchor()) void shutdown();
  });
}
