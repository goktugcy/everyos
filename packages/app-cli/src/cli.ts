#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { keyFingerprint } from "@everyos/app-package";
import { build } from "./build.ts";
import { dev } from "./dev.ts";
import { CommunityClient, loadCommunityToken, saveCommunityToken } from "./community.ts";
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
  community enroll --publisher-id <id> [--registry-url <https origin>]
                              Enroll using EVERYOS_COMMUNITY_INVITATION and your publisher key.
  community submit <file.eosapp> --icon <png|webp> [--screenshot <file>] [--changelog text]
                              Submit for human review; publication requires operator approval.
  community status            Read your submissions and review notes.
  community rotate-token      Replace your developer token (stored locally with mode 0600).
  community revoke <id> <version|*> --reason <text>
  community report <id> [version] --reason <text>
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
      "registry-url": { type: "string" },
      "token-file": { type: "string" },
      icon: { type: "string" },
      screenshot: { type: "string", multiple: true },
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

  if (command === "community") {
    const [action, first, version] = positionals;
    const origin = text("registry-url") ?? "https://registry.everyos.net";
    const credentials = resolve(text("token-file") ?? ".everyos/community-token.json");
    if (action === "enroll") {
      const invitation = process.env.EVERYOS_COMMUNITY_INVITATION;
      const publisherId = text("publisher-id");
      if (!invitation || !publisherId)
        throw new CliError("Enrollment needs --publisher-id and EVERYOS_COMMUNITY_INVITATION");
      const result = await new CommunityClient(origin).enroll(
        publisherId,
        invitation,
        await readFile(resolve(text("key") ?? "keys/publisher.key"), "utf8"),
      );
      await saveCommunityToken(credentials, origin, result.token);
      say(`Enrolled ${publisherId}; credentials saved to ${credentials}`);
      return 0;
    }
    if (action === "report") {
      if (!first || !text("reason"))
        throw new CliError("community report <id> [version] --reason <text>");
      say(
        JSON.stringify(
          await new CommunityClient(origin).request(
            "/v1/reports",
            "POST",
            JSON.stringify({
              appId: first,
              ...(version ? { version } : {}),
              reason: text("reason"),
            }),
          ),
          null,
          2,
        ),
      );
      return 0;
    }
    const credential =
      process.env.EVERYOS_COMMUNITY_TOKEN ?? (await loadCommunityToken(credentials, origin));
    const client = new CommunityClient(origin, credential);
    if (action === "status") say(JSON.stringify(await client.request("/v1/submissions"), null, 2));
    else if (action === "rotate-token") {
      const result = await client.request("/v1/token", "POST", "{}");
      await saveCommunityToken(credentials, origin, result.token);
      say(`Replacement credentials saved to ${credentials}`);
    } else if (action === "submit") {
      const icon = text("icon");
      if (!first || !icon) throw new CliError("community submit <file.eosapp> --icon <png|webp>");
      say(
        JSON.stringify(
          await client.submit(
            resolve(first),
            resolve(text("key") ?? "keys/publisher.key"),
            resolve(icon),
            (Array.isArray(values.screenshot) ? values.screenshot : [])
              .filter((path): path is string => typeof path === "string")
              .map((path) => resolve(path)),
            text("changelog") ?? "",
          ),
          null,
          2,
        ),
      );
    } else if (action === "revoke") {
      if (!first || !version || !text("reason"))
        throw new CliError("community revoke <id> <version|*> --reason <text>");
      say(
        JSON.stringify(
          await client.request(
            "/v1/revocations",
            "POST",
            JSON.stringify({ appId: first, version, reason: text("reason") }),
          ),
          null,
          2,
        ),
      );
    } else
      throw new CliError("community enroll | submit | status | rotate-token | revoke | report");
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
