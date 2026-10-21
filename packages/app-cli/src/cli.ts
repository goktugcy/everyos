#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { keyFingerprint } from "@everyos/app-package";
import { build } from "./build.ts";
import { dev } from "./dev.ts";
import { keygen, signPackageFile } from "./keys.ts";
import { pack } from "./pack.ts";
import { CliError, loadProject, type Project } from "./project.ts";
import {
  initRegistry,
  publishPackage,
  refreshRegistry,
  revokeVersion,
  type RegistryPaths,
} from "./registry.ts";
import { test } from "./test-command.ts";
import { formatFindings, validateBuild } from "./validate.ts";

/** Command output (a CLI prints; the rest of EveryOS logs). */
const say = (text: unknown) => process.stdout.write(`${String(text)}\n`);
const complain = (text: unknown) =>
  process.stderr.write(`${text instanceof Error ? (text.stack ?? text.message) : String(text)}\n`);

const USAGE = `everyos-app — build and publish EveryOS desktop apps

Usage: everyos-app <command> [options]

  dev [--port 5180] [--host 127.0.0.1] [--registry]
        Rebuild on change; open the developer page (a MOCK desktop, not EveryOS).
        --registry also serves a signed development registry a real EveryOS can add.
  build                       Build the package files into dist/.
  validate                    Build and check the package as EveryOS will.
  pack [--out file]           Build, validate and pack <id>-<version>.eosapp.
  test [-- vitest args]       Validate, then run the project's tests.
  keygen [--out keys/publisher]
                              Create an Ed25519 key pair (.key stays private).
  sign <file.eosapp> [--key keys/publisher.key]
                              Sign a package with your publisher key.
  registry init --id <id> --name <name> --publisher-id <com.example> --publisher-name <name>
                              Create your own registry (keys/registry.key signs it).
  publish [--changelog text]  Pack, sign and add this version to your registry.
  registry refresh            Sign the index again before it expires (180 days).
  registry revoke <app id> <version|*> --reason <text>
                              Revoke a version; installed copies turn off on sync.

Nothing is ever published to the official EveryOS registry.`;

function registryPaths(project: Project): RegistryPaths {
  return {
    dir: join(project.root, project.config.registry.dir),
    key: join(project.root, project.config.registry.key),
    publisherKey: join(project.root, project.config.registry.publisherKey),
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      registry: { type: "boolean" },
      out: { type: "string" },
      key: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      "publisher-id": { type: "string" },
      "publisher-name": { type: "string" },
      changelog: { type: "string" },
      reason: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const text = (key: string) => (typeof values[key] === "string" ? values[key] : undefined);
  if (!command || command === "help" || values.help) {
    say(USAGE);
    return 0;
  }
  if (command === "--version" || command === "version") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    say(pkg.version);
    return 0;
  }
  if (command === "keygen") {
    const base = resolve(text("out") ?? "keys/publisher");
    const { fingerprint } = await keygen(base);
    say(`Created ${base}.key (private: never share or commit it) and ${base}.pub`);
    say(`Fingerprint: ${fingerprint}`);
    return 0;
  }
  if (command === "sign") {
    const file = positionals[0];
    if (!file) throw new CliError("sign needs a package file");
    const signature = await signPackageFile(
      resolve(file),
      resolve(text("key") ?? "keys/publisher.key"),
    );
    say(`Signed ${signature.appId} ${signature.version} (${signature.fingerprint})`);
    say(`Wrote ${file}.sig.json`);
    return 0;
  }

  const project = await loadProject();
  switch (command) {
    case "dev": {
      const server = await dev(project, {
        port: Number(text("port") ?? 5180),
        host: text("host") ?? "127.0.0.1",
        registry: values.registry === true,
      });
      say(`Developer page: ${server.url}  (MOCK desktop: not EveryOS)`);
      if (server.registry) {
        say(`Development registry: ${server.registry.url}`);
        say(`  Fingerprint: ${server.registry.fingerprint}`);
        say(`  Public key:\n${server.registry.publicKey}`);
        say(
          "  In EveryOS: App Store → Catalog sources → Add source (Private, on my local network).\n" +
            "  After a change: Sync now, then Update.",
        );
      }
      await new Promise<void>((resolveStop) => process.once("SIGINT", () => resolveStop()));
      await server.close();
      return 0;
    }
    case "build": {
      say(`Built ${await build(project)}`);
      return 0;
    }
    case "validate": {
      const { findings } = await validateBuild(await build(project));
      say(
        findings.length ? formatFindings(findings) : "✔ Valid: EveryOS would accept this package.",
      );
      return findings.some((finding) => finding.level === "error") ? 1 : 0;
    }
    case "pack": {
      const packed = await pack(project, text("out") ? { out: resolve(text("out")!) } : {});
      if (packed.findings.length) say(formatFindings(packed.findings));
      say(`Packed ${packed.file}\n  ${packed.bytes.length} bytes, sha256 ${packed.sha256}`);
      return 0;
    }
    case "test":
      return test(project, positionals);
    case "publish": {
      const paths = registryPaths(project);
      const packed = await pack(project);
      const published = await publishPackage(paths, packed.file, {
        ...(text("changelog") ? { changelog: text("changelog")! } : {}),
        iconFile: join(project.root, project.config.outDir, packed.manifest.icon),
      });
      say(
        `Published ${published.appId} ${published.version} to ${paths.dir} (sequence ${published.sequence}).\n` +
          `Upload that directory to your web server; EveryOS reads index.json from it.`,
      );
      return 0;
    }
    case "registry": {
      const paths = registryPaths(project);
      const [action, ...args] = positionals;
      if (action === "init") {
        const manifest = project.manifest as { publisher?: { id?: string; name?: string } };
        const created = await initRegistry(paths, {
          id: text("id") ?? "apps",
          name: text("name") ?? `${manifest.publisher?.name ?? "My"} apps`,
          publisherId: text("publisher-id") ?? String(manifest.publisher?.id ?? ""),
          publisherName: text("publisher-name") ?? String(manifest.publisher?.name ?? "Publisher"),
        });
        say(`Created the registry in ${paths.dir}`);
        say(`Fingerprint (people compare it when adding the source): ${created.fingerprint}`);
        return 0;
      }
      if (action === "refresh") {
        say(`Signed again (sequence ${await refreshRegistry(paths)})`);
        return 0;
      }
      if (action === "revoke") {
        const [appId, version] = args;
        const reason = text("reason");
        if (!appId || !version || !reason)
          throw new CliError("registry revoke <app id> <version|*> --reason <text>");
        await revokeVersion(paths, appId, version, reason);
        say(`Revoked ${appId} ${version}`);
        return 0;
      }
      if (action === "info") {
        const pub = paths.key.replace(/\.key$/, ".pub");
        if (!existsSync(pub)) throw new CliError("No registry key yet (registry init)");
        say(`Fingerprint: ${keyFingerprint(await readFile(pub, "utf8"))}`);
        return 0;
      }
      throw new CliError("registry init | refresh | revoke | info");
    }
  }
  throw new CliError(`Unknown command "${command}" (everyos-app help)`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    complain(error instanceof CliError ? `✖ ${error.message}` : error);
    process.exit(1);
  },
);
