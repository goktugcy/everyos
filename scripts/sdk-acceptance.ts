#!/usr/bin/env node
/** Runs the actual archives outside the repository, without workspace links or install scripts. */
import { execFile, spawn } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [artifactArgument = "dist/sdk", reportArgument = "dist/sdk-acceptance.json"] =
  process.argv.slice(2);
const artifacts = resolve(artifactArgument),
  reportFile = resolve(reportArgument);
interface PackageReceipt {
  name: string;
  version: string;
  file: string;
  size: number;
  sha256: string;
  integrity: string;
}
const distribution = JSON.parse(await readFile(join(artifacts, "sdk-report.json"), "utf8")) as {
  source: unknown;
  sdkVersion: string;
  packages: PackageReceipt[];
};
if (distribution.packages.length !== 5) throw new Error("Incomplete SDK archive set");
for (const pkg of distribution.packages) {
  if (!/^[a-z0-9][a-z0-9.-]+\.tgz$/.test(pkg.file)) throw new Error("Unsafe SDK artifact path");
  const bytes = await readFile(join(artifacts, pkg.file));
  if (
    bytes.length !== pkg.size ||
    createHash("sha256").update(bytes).digest("hex") !== pkg.sha256 ||
    "sha512-" + createHash("sha512").update(bytes).digest("base64") !== pkg.integrity
  )
    throw new Error("SDK archive checksum mismatch");
}
const work = await mkdtemp(join(tmpdir(), "everyos-sdk-acceptance-"));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TZ: "UTC",
  CI: "true",
  ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
  ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
  ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
  npm_config_cache: join(work, "npm-cache"),
  npm_config_userconfig: join(work, "npmrc"),
  npm_config_globalconfig: join(work, "global-npmrc"),
  npm_config_audit: "false",
  npm_config_fund: "false",
};
const receipts: Array<Record<string, unknown>> = [];
async function run(cwd: string, args: string[], timeout = 180000) {
  try {
    return await exec("npm", args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${args.join(" ")} failed\n${(failure.stdout ?? "").slice(-4000)}\n${(failure.stderr ?? "").slice(-4000)}`,
      { cause: error },
    );
  }
}
async function index(dir: string) {
  const envelope = JSON.parse(await readFile(join(dir, "registry/index.json"), "utf8")) as {
    payload: string;
    signature: string;
  };
  const payload = Buffer.from(envelope.payload, "base64");
  const publicKey = await readFile(join(dir, "keys/registry.pub"), "utf8");
  if (!verify(null, payload, publicKey, Buffer.from(envelope.signature, "base64")))
    throw new Error("Published registry signature is invalid");
  return JSON.parse(payload.toString("utf8")) as {
    sequence: number;
    revoked: Array<{ appId: string; version: string }>;
    apps: Array<{ versions: Array<{ package: { url: string; sha256: string } }> }>;
  };
}
async function developmentServer(dir: string) {
  const child = spawn("npm", ["run", "dev", "--", "--port", "0"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  try {
    const origin = await new Promise<string>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Packaged dev server did not become ready")),
        30000,
      );
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-20000);
        const url = /Developer page: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (url) {
          clearTimeout(timer);
          done(url);
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Packaged dev server exited ${String(code)}`));
      });
    });
    const page = await fetch(origin, { signal: AbortSignal.timeout(10000) });
    if (!page.ok || !(await page.text()).includes("MOCK · NOT EVERYOS"))
      throw new Error("Packaged developer page is missing its simulated-data label");
    const host = await fetch(origin + "/__everyos/host.js", { signal: AbortSignal.timeout(10000) });
    if (!host.ok || (await host.text()).length < 1000)
      throw new Error("Packaged developer host asset is missing");
  } finally {
    if (child.exitCode === null) {
      if (process.platform === "win32") child.kill("SIGINT");
      else process.kill(-child.pid!, "SIGINT");
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid!, "SIGKILL");
          reject(new Error("Packaged dev server did not stop"));
        }, 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }
}
try {
  await writeFile(join(work, "npmrc"), "ignore-scripts=true\naudit=false\nfund=false\n");
  await writeFile(join(work, "global-npmrc"), "");
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ name: "everyos-sdk-acceptance", private: true, type: "module" }),
  );
  const generator = distribution.packages.find((pkg) => pkg.name === "create-everyos-app");
  if (!generator) throw new Error("Generator archive missing");
  for (const template of ["vanilla", "react", "react-widget", "hybrid"]) {
    const dir = join(work, template);
    await run(work, [
      "exec",
      "--yes",
      "--package",
      join(artifacts, generator.file),
      "--",
      "create-everyos-app",
      dir,
      "--template",
      template,
      "--packages",
      artifacts,
    ]);
    const created = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    if (template === "react-widget") {
      const ui = distribution.packages.find((pkg) => pkg.name === "@everyos/app-ui")!;
      created.dependencies[ui.name] = "file:" + join(artifacts, ui.file);
      await writeFile(join(dir, "package.json"), JSON.stringify(created, null, 2));
      await writeFile(
        join(dir, "src/ui-package.tsx"),
        'import { Button, SettingsPanel } from "@everyos/app-ui";\nexport const PublicUiProbe = () => <SettingsPanel><Button>Probe</Button></SettingsPanel>;\n',
      );
      await writeFile(
        join(dir, "test/public-ui.test.tsx"),
        `import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Button, SettingsPanel } from "@everyos/app-ui";
it("renders and handles events from the installed public UI archive", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let clicks = 0;
  try {
    await act(async () => {
      root.render(<SettingsPanel><Button onClick={() => { clicks++; }}>Packaged UI</Button></SettingsPanel>);
    });
    const button = host.querySelector("button");
    expect(button?.textContent).toBe("Packaged UI");
    button?.click();
    expect(clicks).toBe(1);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
`,
      );
    }
    await run(dir, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    for (const name of ["@everyos/app-sdk", "@everyos/app-cli", "@everyos/app-testing"]) {
      const installed = await realpath(join(dir, "node_modules", name));
      if (!installed.startsWith((await realpath(dir)) + "/node_modules/"))
        throw new Error("SDK qualification resolved a workspace link");
    }
    await run(dir, ["run", "typecheck"]);
    const testResult = join(dir, "actual-tests.json");
    await run(dir, ["run", "test", "--", "--", "--reporter=json", "--outputFile=" + testResult]);
    const tests = JSON.parse(await readFile(testResult, "utf8")) as {
      success: boolean;
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
    };
    if (!tests.success || tests.numPassedTests < 1 || tests.numFailedTests || tests.numPendingTests)
      throw new Error("Generated app tests are incomplete");
    if (template === "react-widget" && tests.numPassedTests < 3)
      throw new Error("Public UI runtime qualification did not execute");
    await run(dir, ["run", "pack"]);
    await run(dir, ["exec", "--", "everyos-app", "registry", "init"]);
    await run(dir, ["run", "publish:registry", "--", "--changelog", "Standalone SDK acceptance"]);
    const published = await index(dir);
    const pkg = published.apps[0]?.versions[0]?.package;
    if (
      !pkg ||
      createHash("sha256")
        .update(await readFile(join(dir, "registry", pkg.url)))
        .digest("hex") !== pkg.sha256
    )
      throw new Error("Published package digest differs");
    await run(dir, ["exec", "--", "everyos-app", "registry", "refresh"]);
    const refreshed = await index(dir);
    if (refreshed.sequence <= published.sequence)
      throw new Error("Registry sequence did not advance");
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
      id: string;
      version: string;
    };
    await run(dir, [
      "exec",
      "--",
      "everyos-app",
      "registry",
      "revoke",
      manifest.id,
      manifest.version,
      "--reason",
      "Acceptance revocation",
    ]);
    if (
      !(await index(dir)).revoked.some(
        (item) => item.appId === manifest.id && item.version === manifest.version,
      )
    )
      throw new Error("Registry revocation was lost");
    await developmentServer(dir);
    receipts.push({
      template,
      passed: true,
      tests: tests.numPassedTests,
      installScripts: false,
      workspaceLinks: false,
      typecheck: "passed",
      package: "passed",
      publish: "passed",
      revoke: "passed",
      devHost: "passed",
      ...(template === "react-widget" ? { publicUiRuntime: "passed" } : {}),
    });
    console.log(JSON.stringify({ template, passed: true, tests: tests.numPassedTests }));
  }
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        format: "everyos-sdk-acceptance/1",
        status: "passed",
        source: distribution.source,
        sdkVersion: distribution.sdkVersion,
        runtime: { platform: process.platform, arch: process.arch, node: process.version },
        templates: receipts,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
