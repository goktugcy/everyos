import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import {
  APP_SDK_VERSION,
  compareVersions,
  checkCompatibility,
  type AppManifest,
} from "../packages/app-manifest/src/index.ts";
import { build, loadProject, validateBuild } from "../packages/app-cli/src/index.ts";
import {
  extractPackage,
  keyFingerprint,
  packDirectory,
  PACKAGE_LIMITS,
  sha256Hex,
  signPackage,
} from "../packages/app-package/src/index.ts";
import {
  signRegistryIndex,
  verifyRegistryIndex,
  type RegistryIndex,
} from "../packages/app-registry/src/index.ts";
import { OFFICIAL_APP_REGISTRY } from "../apps/api/src/modules/desktop-apps/anchors.ts";
import { OFFICIAL_APPS, type OfficialApp } from "./official-apps.config.ts";

const exec = promisify(execFile);
function childEnvironment() {
  const env = { ...process.env };
  delete env.EVERYOS_APP_REGISTRY_PRIVATE_KEY;
  delete env.EVERYOS_APP_PUBLISHER_PRIVATE_KEY;
  delete env.EVERYOS_RELEASE_PRIVATE_KEY;
  return env;
}
export const LOCALES = ["de", "en", "es", "fr", "it", "ja", "ko", "ru", "tr", "zh"];
export const REPORT_FILE = "official-apps-report.json";
const INDEX_FILE = "official-apps.json";
const REGISTRY_KEY_FILE = "official-app-registry.pub";
const PUBLISHER_KEY_FILE = "official-app-publisher.pub";
export const PREVIOUS_INDEX_FILE = "official-apps-previous.json";
const REPORT_DOMAIN = "everyos-official-app-report/1\n";
const DAY = 86_400_000;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Count = z.number().int().positive();
const TestStatus = z.strictObject({
  status: z.literal("passed"),
  assertions: Count,
  suites: Count,
  resultsSha256: Hash,
});
const Source = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  dirty: z.boolean(),
  everyosVersion: z.string().min(1),
  sdkVersion: z.string().min(1),
});
export const PermissionPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  apps: z.record(
    z.string(),
    z.strictObject({
      permissions: z.array(z.string()),
      widgets: z.record(z.string(), z.array(z.string())),
      rationale: z.string().min(20),
    }),
  ),
});
const AppResult = z.strictObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  package: z.strictObject({ file: z.string(), size: Count, sha256: Hash }),
  icon: z.strictObject({ file: z.string(), sha256: Hash }),
  build: z.literal("passed"),
  manifest: z.literal("passed"),
  compatibility: z.literal("passed"),
  tests: TestStatus,
  localization: z.strictObject({
    status: z.literal("complete"),
    locales: z.array(z.string()),
    keys: Count,
  }),
  permissionReview: z.literal("matched-policy"),
  permissions: z.array(z.string()),
});
export const ReportSchema = z.strictObject({
  format: z.literal("everyos-official-app-report"),
  schemaVersion: z.literal(1),
  status: z.literal("passed"),
  mode: z.enum(["unsigned", "development", "release"]),
  source: Source,
  builtAt: z.number().int().nonnegative(),
  signedAt: z.number().int().nonnegative().nullable(),
  sequence: z.number().int().positive().nullable(),
  permissionPolicySha256: Hash,
  previousIndexSha256: Hash.nullable(),
  registryFingerprint: Fingerprint.nullable(),
  publisherFingerprint: Fingerprint.nullable(),
  testCommand: z.literal("pnpm exec vitest run --project official-apps --reporter=json"),
  apps: z.array(AppResult).min(1),
});
const Envelope = z.strictObject({
  report: ReportSchema,
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]{86}==$/)
    .nullable(),
});
export type ReleaseReport = z.infer<typeof ReportSchema>;
export interface ReleasePlan {
  root: string;
  apps: readonly OfficialApp[];
  source: z.infer<typeof Source>;
  policy: z.infer<typeof PermissionPolicySchema>;
}
export interface SigningTrust {
  registry: string;
  publisher: string;
}
export const RELEASE_TRUST: SigningTrust = {
  registry: OFFICIAL_APP_REGISTRY.publicKey,
  publisher:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAeMRxTJbhWjMagt7XUsQkTrNsNk3TTNtZHenAw5JPjZE=\n-----END PUBLIC KEY-----\n",
};
export interface TestEvidence {
  byApp: Map<string, z.infer<typeof TestStatus>>;
  error: string | null;
  diagnostics?: string[];
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const sorted = (values: readonly string[]) => [...values].sort();
const same = (actual: unknown, expected: unknown, message: string) => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
};
export const policyDigest = (plan: ReleasePlan) =>
  sha256Hex(Buffer.from(JSON.stringify(plan.policy)));

export async function loadReleasePlan(root: string): Promise<ReleasePlan> {
  const pkg = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: childEnvironment(),
  });
  const { stdout: status } = await exec(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: root, env: childEnvironment() },
  );
  const policy = PermissionPolicySchema.parse(
    JSON.parse(await readFile(join(root, "scripts/official-app-permissions.json"), "utf8")),
  );
  const plan = {
    root,
    apps: OFFICIAL_APPS,
    source: Source.parse({
      commit: commit.trim(),
      dirty: status.trim().length > 0,
      everyosVersion: pkg.version,
      sdkVersion: APP_SDK_VERSION,
    }),
    policy,
  };
  if (plan.apps.length !== 29) throw new Error("The official release requires exactly 29 apps");
  same(
    sorted(Object.keys(policy.apps)),
    sorted(plan.apps.map((app) => app.id)),
    "Permission policy must cover exactly the official catalog",
  );
  return plan;
}

export function testEvidence(text: string, plan: ReleasePlan): TestEvidence {
  const parsed = z
    .object({
      success: z.boolean(),
      testResults: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          assertionResults: z.array(z.object({ status: z.string() })),
        }),
      ),
    })
    .safeParse(JSON.parse(text) as unknown);
  const byApp: TestEvidence["byApp"] = new Map();
  if (!parsed.success) return { byApp, error: "Invalid Vitest JSON report" };
  const digest = sha256Hex(Buffer.from(text));
  for (const app of plan.apps) {
    const prefix = "official-apps/" + app.slug + "/test/";
    const suites = parsed.data.testResults.filter((suite) =>
      relative(plan.root, suite.name).split("\\").join("/").startsWith(prefix),
    );
    const assertions = suites.flatMap((suite) => suite.assertionResults);
    if (
      suites.length &&
      assertions.length &&
      suites.every((suite) => suite.status === "passed") &&
      assertions.every((assertion) => assertion.status === "passed")
    )
      byApp.set(app.id, {
        status: "passed",
        assertions: assertions.length,
        suites: suites.length,
        resultsSha256: digest,
      });
  }
  return { byApp, error: parsed.data.success ? null : "The official-app test run failed" };
}

/** Keep failure identities visible without putting assertion values or environment data in logs. */
export function appTestDiagnostics(text: string, root: string): string[] {
  const report = z
    .object({
      testResults: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          assertionResults: z.array(
            z.object({ status: z.string(), fullName: z.string().optional() }),
          ),
        }),
      ),
      unhandledErrors: z
        .array(z.object({ name: z.string().optional(), type: z.string().optional() }))
        .optional(),
    })
    .safeParse(JSON.parse(text) as unknown);
  if (!report.success) return ["invalid-test-report"];
  const lines = report.data.testResults.flatMap((suite) =>
    suite.status === "passed"
      ? []
      : [
          `${relative(root, suite.name)}: ${suite.status}`,
          ...suite.assertionResults
            .filter((test) => test.status !== "passed")
            .map(
              (test) =>
                `${test.status}: ${(test.fullName ?? "unnamed assertion").replace(/\p{C}/gu, " ").slice(0, 240)}`,
            ),
        ],
  );
  for (const error of report.data.unhandledErrors ?? [])
    lines.push(
      `unhandled: ${String(error.name ?? error.type ?? "unknown")
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .slice(0, 80)}`,
    );
  return lines.slice(0, 100);
}

export async function runAppTests(plan: ReleasePlan, resultFile?: string): Promise<TestEvidence> {
  const scratch = await mkdtemp(join(tmpdir(), "everyos-official-tests-"));
  try {
    const file = join(scratch, "tests.json");
    let failed = false;
    try {
      await exec(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--project",
          "official-apps",
          "--reporter=json",
          "--outputFile",
          file,
        ],
        {
          cwd: plan.root,
          env: childEnvironment(),
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch {
      failed = true;
    }
    try {
      const text = await readFile(file, "utf8");
      if (resultFile) {
        await mkdir(dirname(resultFile), { recursive: true });
        await writeFile(resultFile, text);
      }
      const evidence = testEvidence(text, plan);
      if (failed || evidence.error) evidence.diagnostics = appTestDiagnostics(text, plan.root);
      if (failed) evidence.error = "The official-app test process failed";
      return evidence;
    } catch {
      return { byApp: new Map(), error: "Official-app tests produced no valid result" };
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function localeKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Locale dictionaries must contain objects");
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix + key;
    if (typeof entry === "string" && entry.length > 0)
      return [path.replace(/_(zero|one|two|few|many|other)$/, "")];
    if (entry && typeof entry === "object" && !Array.isArray(entry))
      return localeKeys(entry, path + ".");
    throw new Error("Locale values must be nonempty strings: " + path);
  });
}

async function checkBuilt(plan: ReleasePlan, app: OfficialApp, dir: string) {
  const result = await validateBuild(dir);
  if (!result.manifest || result.findings.some((finding) => finding.level === "error"))
    throw new Error("Package validation failed");
  const manifest = result.manifest;
  if (manifest.id !== app.id || manifest.publisher.id !== "dev.everyos")
    throw new Error("Manifest identity does not match the official catalog");
  const compatible = checkCompatibility(manifest, plan.source);
  if (!compatible.ok) throw new Error("Incompatible app: " + compatible.reason);
  const policy = plan.policy.apps[app.id];
  if (!policy) throw new Error("Permission policy is missing");
  same(
    sorted(manifest.permissions),
    sorted(policy.permissions),
    "App permissions differ from the reviewed policy",
  );
  const widgets = Object.fromEntries(
    manifest.widgets.map((widget) => [widget.id, sorted(widget.permissions)]),
  );
  same(
    widgets,
    Object.fromEntries(
      Object.entries(policy.widgets).map(([id, permissions]) => [id, sorted(permissions)]),
    ),
    "Widget permissions differ from the reviewed policy",
  );
  if (!manifest.locales || manifest.locales.default !== "en")
    throw new Error("Official apps require English as their default locale");
  same(sorted(manifest.locales.supported), LOCALES, "All ten official locales are required");
  let base: string[] | null = null;
  for (const locale of LOCALES) {
    const messages: unknown = JSON.parse(
      await readFile(join(dir, manifest.locales.path, locale + ".json"), "utf8"),
    );
    const keys = sorted([...new Set(localeKeys(messages))]);
    if (!keys.length) throw new Error("Empty locale dictionary");
    if (base) same(keys, base, "Locale keys differ: " + locale);
    else base = keys;
  }
  return {
    manifest,
    localization: { status: "complete" as const, locales: LOCALES, keys: base!.length },
  };
}

export async function buildRelease(
  plan: ReleasePlan,
  out: string,
  tests: TestEvidence,
): Promise<ReleaseReport> {
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  const apps: ReleaseReport["apps"] = [];
  const failures: Array<{ id: string; name: string; status: "failed"; error: string }> = [];
  const scratch = await mkdtemp(join(tmpdir(), "everyos-official-build-"));
  try {
    const folders = (
      await readdir(join(plan.root, "official-apps"), { withFileTypes: true })
    ).filter((entry) => entry.isDirectory());
    for (const folder of folders) {
      if (plan.apps.some((app) => app.slug === folder.name)) continue;
      try {
        await lstat(join(plan.root, "official-apps", folder.name, "manifest.json"));
      } catch {
        continue;
      }
      throw new Error("An app outside the official catalog has a manifest: " + folder.name);
    }
    for (const app of plan.apps) {
      try {
        const evidence = tests.byApp.get(app.id);
        if (!evidence || tests.error) throw new Error(tests.error ?? "No passing app tests");
        const project = await loadProject(join(plan.root, "official-apps", app.slug));
        const buildDir = await build(project, {
          outDir: relative(project.root, join(scratch, app.slug)),
        });
        const checked = await checkBuilt(plan, app, buildDir);
        const packed = await packDirectory(buildDir);
        const inspected = await extractPackage(packed.bytes, join(scratch, app.slug + "-inspect"));
        same(
          inspected.manifest,
          checked.manifest,
          "Packed manifest differs from the validated build",
        );
        const name = app.id + "-" + checked.manifest.version + ".eosapp";
        const iconName = app.id + "." + checked.manifest.icon.split(".").at(-1)!;
        const icon = await readFile(join(buildDir, checked.manifest.icon));
        await writeFile(join(out, name), packed.bytes, { flag: "wx" });
        await writeFile(join(out, iconName), icon, { flag: "wx" });
        apps.push({
          id: app.id,
          slug: app.slug,
          name: app.name,
          version: checked.manifest.version,
          package: { file: name, size: packed.bytes.length, sha256: sha256Hex(packed.bytes) },
          icon: { file: iconName, sha256: sha256Hex(icon) },
          build: "passed",
          manifest: "passed",
          compatibility: "passed",
          tests: evidence,
          localization: checked.localization,
          permissionReview: "matched-policy",
          permissions: checked.manifest.permissions,
        });
      } catch (error) {
        failures.push({
          id: app.id,
          name: app.name,
          status: "failed",
          error: error instanceof Error ? error.message : "App build failed",
        });
      }
    }
    if (failures.length) {
      await writeFile(
        join(out, REPORT_FILE),
        json({
          format: "everyos-official-app-report",
          schemaVersion: 1,
          status: "failed",
          source: plan.source,
          apps: [...apps, ...failures],
        }),
      );
      throw new Error(String(failures.length) + " official app(s) failed; see " + REPORT_FILE);
    }
    const report = ReportSchema.parse({
      format: "everyos-official-app-report",
      schemaVersion: 1,
      status: "passed",
      mode: "unsigned",
      source: plan.source,
      builtAt: Date.now(),
      signedAt: null,
      sequence: null,
      permissionPolicySha256: policyDigest(plan),
      previousIndexSha256: null,
      registryFingerprint: null,
      publisherFingerprint: null,
      testCommand: "pnpm exec vitest run --project official-apps --reporter=json",
      apps,
    });
    await writeFile(join(out, REPORT_FILE), json({ report, signature: null }));
    return report;
  } catch (error) {
    if (!failures.length)
      await writeFile(
        join(out, REPORT_FILE),
        json({
          format: "everyos-official-app-report",
          schemaVersion: 1,
          status: "failed",
          source: plan.source,
          error: error instanceof Error ? error.message : "Release build failed",
        }),
      );
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function artifact(dir: string, file: string, maxBytes: number): Promise<Buffer> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file) || basename(file) !== file)
    throw new Error("Release assets must have flat filenames");
  const path = join(dir, file);
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid release asset: " + file);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error("Oversized release asset: " + file);
  return bytes;
}

async function readReport(dir: string) {
  return Envelope.parse(
    JSON.parse((await artifact(dir, REPORT_FILE, 2 * 1024 * 1024)).toString("utf8")),
  );
}

async function checkArtifacts(
  plan: ReleasePlan,
  dir: string,
  report: ReleaseReport,
  signed: boolean,
) {
  same(report.source, plan.source, "Release source does not match this checkout");
  same(report.permissionPolicySha256, policyDigest(plan), "Permission policy changed");
  same(
    sorted(report.apps.map((app) => app.id)),
    sorted(plan.apps.map((app) => app.id)),
    "Report must contain every official app exactly once",
  );
  const expected = [
    REPORT_FILE,
    ...report.apps.flatMap((app) => [app.package.file, app.icon.file]),
  ];
  if (signed) expected.push(INDEX_FILE, REGISTRY_KEY_FILE, PUBLISHER_KEY_FILE);
  if (signed && report.previousIndexSha256) expected.push(PREVIOUS_INDEX_FILE);
  same(sorted(await readdir(dir)), sorted(expected), "Release assets are missing or unexpected");
  const scratch = await mkdtemp(join(tmpdir(), "everyos-official-verify-"));
  const inspected: Array<{ entry: ReleaseReport["apps"][number]; manifest: AppManifest }> = [];
  try {
    for (const app of plan.apps) {
      const entry = report.apps.find((result) => result.id === app.id)!;
      same(
        { id: entry.id, slug: entry.slug, name: entry.name },
        { id: app.id, slug: app.slug, name: app.name },
        "Report catalog identity changed",
      );
      const bytes = await artifact(dir, entry.package.file, PACKAGE_LIMITS.packedBytes);
      same(
        { size: bytes.length, sha256: sha256Hex(bytes) },
        { size: entry.package.size, sha256: entry.package.sha256 },
        "Package bytes differ from the report: " + app.id,
      );
      if (entry.package.file !== app.id + "-" + entry.version + ".eosapp")
        throw new Error("Unexpected package filename");
      const unpacked = join(scratch, app.slug);
      await extractPackage(bytes, unpacked);
      const checked = await checkBuilt(plan, app, unpacked);
      same(checked.manifest.version, entry.version, "Package version changed");
      same(checked.localization, entry.localization, "Localization report changed");
      same(checked.manifest.permissions, entry.permissions, "Permission report changed");
      const icon = await artifact(dir, entry.icon.file, PACKAGE_LIMITS.unpackedBytes);
      same(
        icon,
        await readFile(join(unpacked, checked.manifest.icon)),
        "Store icon differs from the package",
      );
      same(sha256Hex(icon), entry.icon.sha256, "Store icon digest changed");
      if (entry.icon.file !== app.id + "." + checked.manifest.icon.split(".").at(-1)!)
        throw new Error("Unexpected icon filename");
      inspected.push({ entry, manifest: checked.manifest });
    }
    return inspected;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function reportStatement(report: ReleaseReport) {
  return Buffer.from(REPORT_DOMAIN + JSON.stringify(report));
}

function checkPrevious(
  text: string | undefined,
  report: ReleaseReport,
  trust: SigningTrust,
  now: number,
) {
  if (text === undefined) return null;
  const previous = verifyRegistryIndex(text, trust.registry, {
    official: true,
    allowExpired: true,
    now,
  });
  if (previous.registry.id !== "official")
    throw new Error("Previous index is not the official registry");
  if (report.sequence === null || report.sequence <= previous.sequence)
    throw new Error("Release sequence must increase beyond the previous index");
  for (const app of report.apps) {
    const versions = previous.apps.find((entry) => entry.id === app.id)?.versions ?? [];
    for (const version of versions) {
      if (compareVersions(app.version, version.version) < 0)
        throw new Error("App version rollback: " + app.id);
      if (app.version === version.version)
        same(
          { size: app.package.size, sha256: app.package.sha256 },
          { size: version.package.size, sha256: version.package.sha256 },
          "Published app versions are immutable: " + app.id,
        );
    }
    if (
      previous.revoked.some(
        (entry) =>
          entry.appId === app.id && (entry.version === "*" || entry.version === app.version),
      )
    )
      throw new Error("Cannot publish a revoked app version: " + app.id);
  }
  return previous;
}

export async function signRelease(
  plan: ReleasePlan,
  dir: string,
  options: {
    registryPrivateKey: string;
    publisherPrivateKey: string;
    trust: SigningTrust;
    mode: "development" | "release";
    sequence: number;
    now?: number;
    previousIndex?: string;
  },
): Promise<ReleaseReport> {
  let registry: string;
  let publisher: string;
  try {
    registry = createPublicKey(createPrivateKey(options.registryPrivateKey))
      .export({ type: "spki", format: "pem" })
      .toString();
    publisher = createPublicKey(createPrivateKey(options.publisherPrivateKey))
      .export({ type: "spki", format: "pem" })
      .toString();
    same(
      keyFingerprint(registry),
      keyFingerprint(options.trust.registry),
      "Registry key does not match the pinned key",
    );
    same(
      keyFingerprint(publisher),
      keyFingerprint(options.trust.publisher),
      "Publisher key does not match the pinned key",
    );
  } catch {
    throw new Error("Signing keys must be Ed25519 and match the pinned trust anchors");
  }
  const envelope = await readReport(dir);
  if (envelope.report.mode !== "unsigned" || envelope.signature !== null)
    throw new Error("Only an unsigned build can be signed");
  if (options.mode === "release" && plan.source.dirty)
    throw new Error("Official releases require a clean source checkout");
  const inspected = await checkArtifacts(plan, dir, envelope.report, false);
  const now = options.now ?? Date.now();
  const report = ReportSchema.parse({
    ...envelope.report,
    mode: options.mode,
    signedAt: now,
    sequence: options.sequence,
    registryFingerprint: keyFingerprint(registry),
    publisherFingerprint: keyFingerprint(publisher),
    previousIndexSha256:
      options.previousIndex === undefined ? null : sha256Hex(Buffer.from(options.previousIndex)),
  });
  const previous = checkPrevious(options.previousIndex, report, options.trust, now);
  const index: RegistryIndex = {
    format: "everyos-app-registry",
    schemaVersion: 1,
    registry: { id: "official", name: "EveryOS", homepage: "https://github.com/goktugcy/everyos" },
    sequence: options.sequence,
    publishedAt: now,
    expiresAt: now + 180 * DAY,
    publishers: [{ id: "dev.everyos", name: "EveryOS", keys: [publisher] }],
    apps: inspected.map(({ entry, manifest }) => ({
      id: entry.id,
      publisher: "dev.everyos",
      icon: entry.icon.file,
      screenshots: [],
      versions: [
        {
          version: entry.version,
          manifest,
          publishedAt: now,
          package: {
            url: entry.package.file,
            size: entry.package.size,
            sha256: entry.package.sha256,
            signature: signPackage(
              {
                appId: entry.id,
                version: entry.version,
                size: entry.package.size,
                sha256: entry.package.sha256,
              },
              options.publisherPrivateKey,
            ),
          },
        },
      ],
    })),
    revoked: previous?.revoked ?? [],
  };
  if (options.previousIndex !== undefined)
    await writeFile(join(dir, PREVIOUS_INDEX_FILE), options.previousIndex, { flag: "wx" });
  await writeFile(
    join(dir, INDEX_FILE),
    signRegistryIndex(index, options.registryPrivateKey, { official: true }),
    { flag: "wx" },
  );
  await writeFile(join(dir, REGISTRY_KEY_FILE), registry, { flag: "wx" });
  await writeFile(join(dir, PUBLISHER_KEY_FILE), publisher, { flag: "wx" });
  const signature = sign(null, reportStatement(report), options.registryPrivateKey).toString(
    "base64",
  );
  await writeFile(join(dir, REPORT_FILE), json({ report, signature }));
  await verifyRelease(plan, dir, options.trust, options.mode, now);
  return report;
}

export async function verifyRelease(
  plan: ReleasePlan,
  dir: string,
  trust: SigningTrust = RELEASE_TRUST,
  mode: "development" | "release" = "release",
  now = Date.now(),
): Promise<ReleaseReport> {
  const { report, signature } = await readReport(dir);
  if (report.mode !== mode || !signature || report.signedAt === null || report.sequence === null)
    throw new Error("A signed " + mode + " report is required");
  if (mode === "release" && report.source.dirty)
    throw new Error("Dirty source cannot qualify a release");
  if (!verify(null, reportStatement(report), trust.registry, Buffer.from(signature, "base64")))
    throw new Error("Invalid release report signature");
  same(report.registryFingerprint, keyFingerprint(trust.registry), "Registry fingerprint changed");
  same(
    report.publisherFingerprint,
    keyFingerprint(trust.publisher),
    "Publisher fingerprint changed",
  );
  same(
    keyFingerprint((await artifact(dir, REGISTRY_KEY_FILE, 1024)).toString("utf8")),
    keyFingerprint(trust.registry),
    "Registry public key changed",
  );
  same(
    keyFingerprint((await artifact(dir, PUBLISHER_KEY_FILE, 1024)).toString("utf8")),
    keyFingerprint(trust.publisher),
    "Publisher public key changed",
  );
  const index = verifyRegistryIndex(
    (await artifact(dir, INDEX_FILE, 12 * 1024 * 1024)).toString("utf8"),
    trust.registry,
    { official: true, now, minSequence: report.sequence },
  );
  same(
    { id: index.registry.id, sequence: index.sequence, publishedAt: index.publishedAt },
    { id: "official", sequence: report.sequence, publishedAt: report.signedAt },
    "Index release identity changed",
  );
  same(
    index.publishers,
    [
      {
        id: "dev.everyos",
        name: "EveryOS",
        keys: [(await artifact(dir, PUBLISHER_KEY_FILE, 1024)).toString("utf8")],
      },
    ],
    "Unexpected publisher keys",
  );
  const previousText = report.previousIndexSha256
    ? (await artifact(dir, PREVIOUS_INDEX_FILE, 12 * 1024 * 1024)).toString("utf8")
    : undefined;
  if (previousText !== undefined)
    same(
      sha256Hex(Buffer.from(previousText)),
      report.previousIndexSha256,
      "Previous index digest changed",
    );
  const previous = checkPrevious(previousText, report, trust, now);
  same(index.revoked, previous?.revoked ?? [], "Previous revocations must be preserved");
  same(
    sorted(index.apps.map((app) => app.id)),
    sorted(plan.apps.map((app) => app.id)),
    "Signed index must contain the complete official catalog",
  );
  const inspected = await checkArtifacts(plan, dir, report, true);
  for (const { entry, manifest } of inspected) {
    const app = index.apps.find((app) => app.id === entry.id)!;
    if (app.versions.length !== 1)
      throw new Error("A release lists exactly one version of each app");
    const version = app.versions[0]!;
    same(version.manifest, manifest, "Index manifest differs from the package");
    same(
      {
        version: version.version,
        url: version.package.url,
        size: version.package.size,
        sha256: version.package.sha256,
        publishedAt: version.publishedAt,
        icon: app.icon,
      },
      {
        version: entry.version,
        url: entry.package.file,
        size: entry.package.size,
        sha256: entry.package.sha256,
        publishedAt: report.signedAt,
        icon: entry.icon.file,
      },
      "Signed package metadata changed",
    );
  }
  return report;
}
