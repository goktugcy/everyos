/**
 * A desktop app registry for end-to-end tests: builds the probe app with the real SDK, packs it as
 * `.eosapp`, signs package and index with throwaway keys and serves them over HTTP. Production
 * code paths (sync, verification, installation, the runtime) handle it like any registry.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  generatePublisherKeys,
  packDirectory,
  sha256Hex,
  signPackage,
} from "../../packages/app-package/src/index.ts";
import { signRegistryIndex, type RegistryIndex } from "../../packages/app-registry/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d30000000049454e44ae426082",
  "hex",
);

async function buildProbe(): Promise<Buffer> {
  const source = join(here, "fixtures/probe-app");
  const out = await mkdtemp(join(tmpdir(), "everyos-probe-"));
  for (const [entry, output] of [
    ["main.ts", "app.js"],
    ["widget.ts", "widget.js"],
  ] as const)
    await build({
      entryPoints: [join(source, entry)],
      bundle: true,
      format: "esm",
      target: "es2022",
      outfile: join(out, output),
      logLevel: "silent",
    });
  for (const file of [
    "manifest.json",
    "index.html",
    "widget.html",
    "locales/en.json",
    "locales/tr.json",
  ]) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    await copyFile(join(source, file), join(out, file));
  }
  await writeFile(join(out, "icon.png"), PNG);
  return (await packDirectory(out)).bytes;
}

export async function startAppRegistry(
  port: number,
): Promise<{ url: string; publicKey: string; close: () => void }> {
  const registryKeys = generatePublisherKeys();
  const publisherKeys = generatePublisherKeys();
  const bytes = await buildProbe();
  const manifest = JSON.parse(
    await readFile(join(here, "fixtures/probe-app/manifest.json"), "utf8"),
  ) as RegistryIndex["apps"][number]["versions"][number]["manifest"];
  const digest = {
    appId: manifest.id,
    version: manifest.version,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  };
  const now = Date.now();
  const index: RegistryIndex = {
    format: "everyos-app-registry",
    schemaVersion: 1,
    registry: { id: "official", name: "EveryOS" },
    sequence: 1,
    publishedAt: now - 60_000,
    expiresAt: now + 30 * 86_400_000,
    publishers: [{ id: "dev.everyos", name: "EveryOS", keys: [publisherKeys.publicKey] }],
    apps: [
      {
        id: manifest.id,
        publisher: "dev.everyos",
        icon: "icons/probe.png",
        screenshots: [],
        versions: [
          {
            version: manifest.version,
            manifest,
            package: {
              url: `packages/${manifest.id}-${manifest.version}.eosapp`,
              size: bytes.length,
              sha256: digest.sha256,
              signature: signPackage(digest, publisherKeys.privateKey),
            },
            publishedAt: now - 60_000,
          },
        ],
      },
    ],
    revoked: [],
  };
  const files = new Map<string, Buffer>([
    [
      "/index.json",
      Buffer.from(signRegistryIndex(index, registryKeys.privateKey, { official: true })),
    ],
    ["/icons/probe.png", PNG],
    [`/packages/${manifest.id}-${manifest.version}.eosapp`, bytes],
  ]);
  const server = createServer((request, response) => {
    const body = files.get(request.url ?? "");
    response.writeHead(body ? 200 : 404);
    response.end(body);
  });
  server.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${port}/index.json`,
    publicKey: registryKeys.publicKey,
    close: () => server.close(),
  };
}
