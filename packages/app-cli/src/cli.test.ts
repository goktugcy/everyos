import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectPackage, verifyPackage } from "@everyos/app-package";
import { verifyRegistryIndex } from "@everyos/app-registry";
import { createProject, TEMPLATES } from "../../create-everyos-app/src/create.ts";
import { afterAll, describe, expect, it } from "vitest";
import {
  build,
  dev,
  initRegistry,
  loadProject,
  pack,
  publishPackage,
  refreshRegistry,
  revokeVersion,
  validateBuild,
} from "./index.ts";
import { htmlProblems } from "./validate.ts";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const work = await mkdtemp(join(tmpdir(), "everyos-cli-"));
afterAll(() => rm(work, { recursive: true, force: true }));

/** A generated project's node_modules, linked to this repository's packages (no npm install). */
async function link(dir: string): Promise<void> {
  const links: Record<string, string> = {
    "@everyos/app-sdk": join(repo, "packages/app-sdk"),
    "@everyos/app-testing": join(repo, "packages/app-testing"),
    "@everyos/app-manifest": join(repo, "packages/app-manifest"),
    react: realpathSync(join(repo, "apps/web/node_modules/react")),
    "react-dom": realpathSync(join(repo, "apps/web/node_modules/react-dom")),
    "@types/react": realpathSync(join(repo, "apps/web/node_modules/@types/react")),
    "@types/react-dom": realpathSync(join(repo, "apps/web/node_modules/@types/react-dom")),
    vitest: realpathSync(join(repo, "node_modules/vitest")),
    "happy-dom": realpathSync(join(repo, "node_modules/happy-dom")),
    typescript: realpathSync(join(repo, "node_modules/typescript")),
    "@types/node": realpathSync(join(repo, "node_modules/@types/node")),
  };
  for (const [name, target] of Object.entries(links)) {
    const path = join(dir, "node_modules", name);
    await mkdir(join(path, ".."), { recursive: true });
    await symlink(target, path, "dir");
  }
}

describe("create-everyos-app and everyos-app", () => {
  it.each(TEMPLATES)(
    "the %s template builds, validates, packs, typechecks and passes its own tests",
    async (template) => {
      const dir = join(work, `my-${template}`);
      const created = await createProject({
        dir,
        template,
        publisherId: "com.example",
        publisherName: "Example Ltd",
        name: `My "${template}" app`,
        packages: "npm",
      });
      expect(created.id).toBe(`com.example.my-${template}`);
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        name: string;
        id: string;
      };
      expect(manifest).toMatchObject({ id: created.id, name: `My "${template}" app` });
      await link(dir);

      const project = await loadProject(dir);
      const { findings } = await validateBuild(await build(project));
      expect(findings.filter((finding) => finding.level === "error")).toEqual([]);
      const packed = await pack(project);
      expect((await inspectPackage(packed.bytes)).manifest.id).toBe(created.id);

      // The project's own checks, as its developer runs them.
      await run(join(dir, "node_modules/typescript/bin/tsc"), ["-p", "tsconfig.json"], {
        cwd: dir,
      });
      const tests = await run(
        process.execPath,
        [join(dir, "node_modules/vitest/vitest.mjs"), "run", "--root", dir],
        { cwd: dir },
      ).catch((error: { stdout: string; stderr: string }) => {
        throw new Error(`${error.stdout}\n${error.stderr}`);
      });
      expect(tests.stdout).toMatch(/Tests\s+\d+ passed/);
    },
    120_000,
  );

  it("refuses projects EveryOS would refuse, and HTML its sandbox would block", async () => {
    expect(htmlProblems('<script src="https://cdn.example.com/x.js"></script>')).toHaveLength(1);
    expect(htmlProblems("<script>alert(1)</script>")).toHaveLength(1);
    expect(htmlProblems('<button onclick="go()">Go</button>')).toHaveLength(1);
    expect(htmlProblems('<script type="module" src="app.js"></script>')).toEqual([]);

    const dir = join(work, "broken");
    await createProject({ dir, template: "vanilla", packages: "npm" });
    await link(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...manifest, permissions: ["shell:exec"], icon: "missing.png" }),
    );
    writeFileSync(join(dir, "public/locales/tr.json"), JSON.stringify({ app: { name: "Bozuk" } }));
    const project = await loadProject(dir);
    const { findings } = await validateBuild(await build(project));
    const messages = findings.map((finding) => `${finding.file}: ${finding.message}`).join("\n");
    expect(messages).toContain("manifest.json: permissions.0");
    await expect(pack(project)).rejects.toThrow(/not valid/);
    // Fixed permissions: the missing icon and the incomplete translation remain.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, icon: "missing.png" }));
    const second = await validateBuild(await build(await loadProject(dir)));
    expect(second.findings.map((finding) => finding.file)).toEqual(
      expect.arrayContaining(["missing.png", "locales/tr.json"]),
    );

    // Plural forms follow each language: Turkish needs only `_other` where English has `_one` too.
    const texts = (extra: Record<string, string>) => ({ app: { name: "Notes" }, ...extra });
    writeFileSync(
      join(dir, "public/locales/en.json"),
      JSON.stringify(texts({ notes_one: "{{count}} note", notes_other: "{{count}} notes" })),
    );
    writeFileSync(
      join(dir, "public/locales/tr.json"),
      JSON.stringify(texts({ notes_other: "{{count}} not" })),
    );
    const plural = await validateBuild(await build(await loadProject(dir)));
    expect(plural.findings.filter((finding) => finding.file === "locales/tr.json")).toEqual([]);
    writeFileSync(join(dir, "public/locales/tr.json"), JSON.stringify(texts({})));
    const missing = await validateBuild(await build(await loadProject(dir)));
    expect(
      missing.findings.find((finding) => finding.file === "locales/tr.json")?.message,
    ).toContain("notes");
  });

  it("serves the app under EveryOS's sandbox policy with a mock desktop page", async () => {
    const dir = join(work, "devserver");
    await createProject({ dir, template: "react-widget", packages: "npm" });
    await link(dir);
    const server = await dev(await loadProject(dir), { port: 0, log: () => undefined });
    try {
      const page = await fetch(`${server.url}/`);
      expect(await page.text()).toContain("MOCK · NOT EVERYOS");
      const state = (await (await fetch(`${server.url}/__everyos/state`)).json()) as {
        build: { ok: boolean };
        findings: Array<{ level: string }>;
        manifest: { widgets: unknown[] };
      };
      expect(state.build.ok).toBe(true);
      expect(state.findings.filter((finding) => finding.level === "error")).toEqual([]);
      expect(state.manifest.widgets).toHaveLength(1);
      const app = await fetch(`${server.url}/app/index.html`);
      expect(app.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      expect((await fetch(`${server.url}/app/app.js`)).status).toBe(200);
      expect((await fetch(`${server.url}/app/../manifest.json`)).status).toBe(404);
      const script = await (await fetch(`${server.url}/__everyos/host.js`)).text();
      expect(script).toContain("EveryOS MOCK host");
    } finally {
      await server.close();
    }
  }, 60_000);

  it("publishes to the developer's own signed registry, never changing a published version", async () => {
    const dir = join(work, "publisher");
    await createProject({
      dir,
      template: "vanilla",
      publisherId: "com.example",
      publisherName: "Example Ltd",
      packages: "npm",
    });
    await link(dir);
    const project = await loadProject(dir);
    const paths = {
      dir: join(dir, "registry"),
      key: join(dir, "keys/registry.key"),
      publisherKey: join(dir, "keys/publisher.key"),
    };
    const created = await initRegistry(paths, {
      id: "example",
      name: "Example apps",
      publisherId: "com.example",
      publisherName: "Example Ltd",
    });
    expect(created.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const packed = await pack(project);
    const published = await publishPackage(paths, packed.file, {
      changelog: "First release",
      iconFile: join(dir, "dist/icon.png"),
    });
    expect(published).toMatchObject({ version: "1.0.0", sequence: 2 });

    const index = verifyRegistryIndex(
      readFileSync(join(paths.dir, "index.json"), "utf8"),
      created.publicKey,
      { official: false },
    );
    const entry = index.apps[0]!.versions[0]!;
    expect(entry.package.url).toBe(`packages/${packed.manifest.id}-1.0.0.eosapp`);
    expect(existsSync(join(paths.dir, entry.package.url))).toBe(true);
    expect(
      verifyPackage(
        {
          appId: packed.manifest.id,
          version: "1.0.0",
          sha256: entry.package.sha256,
          size: entry.package.size,
        },
        entry.package.signature,
        index.publishers[0]!.keys[0]!,
      ),
    ).toBe(true);
    // Publishing the same bytes again changes nothing; other bytes under the same version fail.
    expect((await publishPackage(paths, packed.file)).sequence).toBe(2);
    writeFileSync(join(dir, "src/extra.txt"), "x");
    writeFileSync(join(dir, "public/notes.txt"), "changed");
    const changed = await pack(project);
    await expect(publishPackage(paths, changed.file)).rejects.toThrow(/raise the version/);
    expect(await refreshRegistry(paths)).toBe(3);
    await revokeVersion(paths, packed.manifest.id, "1.0.0", "Broken build");
    const revoked = verifyRegistryIndex(
      readFileSync(join(paths.dir, "index.json"), "utf8"),
      created.publicKey,
      { official: false },
    );
    expect(revoked.revoked).toEqual([
      { appId: packed.manifest.id, version: "1.0.0", reason: "Broken build" },
    ]);
    // Private keys are the owner's only.
    expect((await import("node:fs")).statSync(paths.key).mode & 0o077).toBe(0);
  }, 60_000);
});
