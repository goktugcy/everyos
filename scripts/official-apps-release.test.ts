import { previousOfficialIndex } from "./previous-official-apps.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatePublisherKeys,
  keyFingerprint,
  sha256Hex,
} from "../packages/app-package/src/index.ts";
import { signRegistryIndex, verifyRegistryIndex } from "../packages/app-registry/src/index.ts";
import { OFFICIAL_APPS } from "./official-apps.config.ts";
import {
  buildRelease,
  LOCALES,
  REPORT_FILE,
  signRelease,
  testEvidence,
  appTestDiagnostics,
  verifyRelease,
  RELEASE_TRUST,
  type ReleasePlan,
} from "./official-apps-release.ts";

const registry = generatePublisherKeys();
const publisher = generatePublisherKeys();
const trust = { registry: registry.publicKey, publisher: publisher.publicKey };
const now = Date.now();
let root: string;
let plan: ReleasePlan;
let manifest: Record<string, unknown>;
const app = OFFICIAL_APPS.find((entry) => entry.slug === "notes")!;
const manifestFile = () => join(root, "official-apps/notes/manifest.json");
const evidence = (status = "passed", success = true) =>
  testEvidence(
    JSON.stringify({
      success,
      testResults: [
        {
          name: join(root, "official-apps/notes/test/app.test.ts"),
          status: "passed",
          assertionResults: [{ status }],
        },
      ],
    }),
    plan,
  );
const prepare = () => buildRelease(plan, join(root, "output"), evidence());
const signing = (mode: "development" | "release" = "development") => ({
  registryPrivateKey: registry.privateKey,
  publisherPrivateKey: publisher.privateKey,
  trust,
  mode,
  sequence: 17,
  now,
});
const signed = async () => {
  await prepare();
  await signRelease(plan, join(root, "output"), signing());
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "everyos-official-release-test-"));
  const dir = join(root, "official-apps/notes/public");
  await mkdir(join(dir, "locales"), { recursive: true });
  const original: Record<string, unknown> = JSON.parse(
    await readFile(new URL("../official-apps/notes/manifest.json", import.meta.url), "utf8"),
  );
  manifest = { ...original, permissions: ["storage:app"], widgets: [] };
  await writeFile(manifestFile(), JSON.stringify(manifest));
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><html><body><script type="module" src="app.js"></script></body></html>',
  );
  await writeFile(join(dir, "app.js"), 'document.body.dataset.fixture = "true";');
  await writeFile(
    join(dir, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
  );
  for (const locale of LOCALES)
    await writeFile(
      join(dir, "locales", locale + ".json"),
      JSON.stringify({ app: { name: "Fixture" }, text: "Translated fixture" }),
    );
  plan = {
    root,
    apps: [app],
    source: { commit: "a".repeat(40), dirty: false, everyosVersion: "0.1.36", sdkVersion: "1.0.0" },
    policy: {
      schemaVersion: 1,
      apps: {
        [app.id]: {
          permissions: ["storage:app"],
          widgets: {},
          rationale: "Fixture stores only its own application state.",
        },
      },
    },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Official app distribution", () => {
  it("pins both owner-provided production public keys", () => {
    expect(keyFingerprint(RELEASE_TRUST.registry)).toBe(
      "sha256:d0670c89bb20001940869994f8c59e10dfa44c552115a2e06496b47ff1ae5852",
    );
    expect(keyFingerprint(RELEASE_TRUST.publisher)).toBe(
      "sha256:1c201c4a9f4a8d00739a2d08fa4f6f58cecd1830acf85f923e34694e717449f8",
    );
  });
  it("builds reproducible archives, signs the complete chain and verifies a flat release offline", async () => {
    const first = await prepare();
    const second = await buildRelease(plan, join(root, "another-output"), evidence());
    expect(second.apps[0]!.package.sha256).toBe(first.apps[0]!.package.sha256);
    expect(first.apps[0]!.tests.assertions).toBe(1);
    expect(first.apps[0]!.localization.locales).toEqual(LOCALES);
    const report = await signRelease(plan, join(root, "output"), signing());
    expect(await verifyRelease(plan, join(root, "output"), trust, "development", now)).toEqual(
      report,
    );
    const text = await readFile(join(root, "output/official-apps.json"), "utf8");
    const index = verifyRegistryIndex(text, trust.registry, { official: true, now });
    expect(index.apps[0]!.versions[0]!.package.url).toBe("dev.everyos.notes-1.0.0.eosapp");
    expect(index.apps[0]!.icon).toBe("dev.everyos.notes.svg");
    const stored = await readFile(join(root, "output", REPORT_FILE), "utf8");
    expect(stored).not.toContain("PRIVATE KEY");
    expect(stored).not.toContain(registry.privateKey);
    expect(stored).not.toContain(publisher.privateKey);
    expect(report.mode).toBe("development");
    await expect(verifyRelease(plan, join(root, "output"))).rejects.toThrow("signed release");
  });

  it.each(["pending", "failed", "todo"])(
    "refuses %s assertions and records failed app identities",
    async (status) => {
      await expect(buildRelease(plan, join(root, "output"), evidence(status))).rejects.toThrow(
        "1 official app",
      );
      const failure = JSON.parse(await readFile(join(root, "output", REPORT_FILE), "utf8"));
      expect(failure.status).toBe("failed");
      expect(failure.apps).toContainEqual(
        expect.objectContaining({ id: app.id, name: app.name, status: "failed" }),
      );
    },
  );

  it("retains failed suite and assertion names and unhandled error kinds without assertion secrets", () => {
    const details = appTestDiagnostics(
      JSON.stringify({
        testResults: [
          {
            name: join(root, "official-apps/notes/test/app.test.ts"),
            status: "failed",
            assertionResults: [
              {
                status: "failed",
                fullName: "Notes saves a note",
                failureMessages: ["private assertion value"],
              },
            ],
          },
        ],
        unhandledErrors: [{ name: "TimeoutError", message: "private environment value" }],
      }),
      root,
    );
    expect(details).toContain("official-apps/notes/test/app.test.ts: failed");
    expect(details).toContain("failed: Notes saves a note");
    expect(details).toContain("unhandled: TimeoutError");
    expect(JSON.stringify(details)).not.toContain("private");
  });

  it("does not accept a globally failed run or tests outside the app's directory", async () => {
    expect(evidence("passed", false).error).not.toBeNull();
    const result = testEvidence(
      JSON.stringify({
        success: true,
        testResults: [
          {
            name: join(root, "other/test.ts"),
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
      plan,
    );
    expect(result.byApp.size).toBe(0);
    await expect(buildRelease(plan, join(root, "output"), result)).rejects.toThrow(
      "1 official app",
    );
  });

  it.each(["permission", "widget", "locale", "blank", "sdk", "identity", "default-locale"])(
    "refuses an app with a changed %s contract",
    async (change) => {
      if (change === "permission") manifest.permissions = ["storage:app", "network:outbound"];
      if (change === "widget") plan.policy.apps[app.id]!.widgets = { unexpected: ["storage:app"] };
      if (change === "sdk") manifest.sdk = "^2.0.0";
      if (change === "identity") manifest.id = "dev.everyos.other";
      if (change === "default-locale") (manifest.locales as { default: string }).default = "tr";
      if (change === "locale")
        await writeFile(
          join(root, "official-apps/notes/public/locales/tr.json"),
          JSON.stringify({ app: { name: "Missing text" } }),
        );
      if (change === "blank")
        await writeFile(
          join(root, "official-apps/notes/public/locales/tr.json"),
          JSON.stringify({ app: { name: "" }, text: "Fixture" }),
        );
      await writeFile(manifestFile(), JSON.stringify(manifest));
      await expect(prepare()).rejects.toThrow("1 official app");
    },
  );

  it("requires every catalog app and rejects an unlisted manifest", async () => {
    plan.apps = [
      ...plan.apps,
      { ...app, id: "dev.everyos.missing", slug: "missing", name: "Missing" },
    ];
    const tests = evidence();
    tests.byApp.set("dev.everyos.missing", tests.byApp.get(app.id)!);
    await expect(buildRelease(plan, join(root, "output"), tests)).rejects.toThrow("1 official app");
    const failure = JSON.parse(await readFile(join(root, "output", REPORT_FILE), "utf8"));
    expect(failure.apps).toContainEqual(
      expect.objectContaining({ id: "dev.everyos.missing", status: "failed" }),
    );
    await mkdir(join(root, "official-apps/excluded"));
    await writeFile(join(root, "official-apps/excluded/manifest.json"), "{}");
    await expect(buildRelease(plan, join(root, "excluded-output"), evidence())).rejects.toThrow(
      "outside the official catalog",
    );
  });

  it("refuses unpinned signing keys before changing the unsigned candidate", async () => {
    await prepare();
    await expect(
      signRelease(plan, join(root, "output"), { ...signing(), trust: RELEASE_TRUST }),
    ).rejects.toThrow("pinned trust anchors");
    expect(JSON.parse(await readFile(join(root, "output", REPORT_FILE), "utf8")).report.mode).toBe(
      "unsigned",
    );
  });

  it("requires clean source for production signing and refuses dirty release attestations", async () => {
    plan.source.dirty = true;
    await prepare();
    await expect(signRelease(plan, join(root, "output"), signing("release"))).rejects.toThrow(
      "clean source",
    );
  });

  it("detects modified test evidence in the signed report", async () => {
    await signed();
    const file = join(root, "output", REPORT_FILE);
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.report.apps[0].tests.assertions = 999;
    await writeFile(file, JSON.stringify(envelope));
    await expect(
      verifyRelease(plan, join(root, "output"), trust, "development", now),
    ).rejects.toThrow("report signature");
  });

  it.each(["package", "icon", "missing", "extra", "symlink"])(
    "rejects %s asset tampering",
    async (change) => {
      await signed();
      const out = join(root, "output");
      if (change === "package")
        await writeFile(join(out, "dev.everyos.notes-1.0.0.eosapp"), "changed");
      if (change === "icon") await writeFile(join(out, "dev.everyos.notes.svg"), "<svg/>");
      if (change === "missing") await rm(join(out, "dev.everyos.notes-1.0.0.eosapp"));
      if (change === "extra") await writeFile(join(out, "unexpected.eosapp"), "extra");
      if (change === "symlink") {
        await rm(join(out, "dev.everyos.notes.svg"));
        await symlink(
          join(root, "official-apps/notes/public/icon.svg"),
          join(out, "dev.everyos.notes.svg"),
        );
      }
      await expect(verifyRelease(plan, out, trust, "development", now)).rejects.toThrow();
    },
  );

  it("refuses a correctly signed but incomplete index or an expired index", async () => {
    await signed();
    const file = join(root, "output/official-apps.json");
    const index = verifyRegistryIndex(await readFile(file, "utf8"), trust.registry, {
      official: true,
      now,
    });
    await expect(
      verifyRelease(plan, join(root, "output"), trust, "development", now + 181 * 86_400_000),
    ).rejects.toThrow("expired");
    index.apps = [];
    await writeFile(file, signRegistryIndex(index, registry.privateKey, { official: true }));
    await expect(
      verifyRelease(plan, join(root, "output"), trust, "development", now),
    ).rejects.toThrow("complete official catalog");
  });

  it("binds artifacts to their source checkout and reviewed permission policy", async () => {
    const report = await prepare();
    expect(report.apps[0]!.package.sha256).toBe(
      sha256Hex(await readFile(join(root, "output", report.apps[0]!.package.file))),
    );
    await signRelease(plan, join(root, "output"), signing());
    plan.source.commit = "b".repeat(40);
    await expect(
      verifyRelease(plan, join(root, "output"), trust, "development", now),
    ).rejects.toThrow("source");
    plan.source.commit = "a".repeat(40);
    plan.policy.apps[app.id]!.rationale += " Policy changed.";
    await expect(
      verifyRelease(plan, join(root, "output"), trust, "development", now),
    ).rejects.toThrow("policy changed");
  });
  it("verifies a clean production candidate against its configured trust", async () => {
    await prepare();
    const report = await signRelease(plan, join(root, "output"), signing("release"));
    expect((await verifyRelease(plan, join(root, "output"), trust, "release", now)).mode).toBe(
      "release",
    );
    expect(report.source.dirty).toBe(false);
  });

  it("preserves prior revocations, checks immutable versions and keeps the sequence increasing", async () => {
    await signed();
    const previous = verifyRegistryIndex(
      await readFile(join(root, "output/official-apps.json"), "utf8"),
      trust.registry,
      { official: true, now },
    );
    previous.revoked = [{ appId: app.id, version: "0.8.0", reason: "Old unsafe fixture version" }];
    const text = signRegistryIndex(previous, registry.privateKey, { official: true });
    await buildRelease(plan, join(root, "next"), evidence());
    await expect(
      signRelease(plan, join(root, "next"), { ...signing(), previousIndex: text }),
    ).rejects.toThrow("sequence");
    const report = await signRelease(plan, join(root, "next"), {
      ...signing(),
      previousIndex: text,
      sequence: 18,
    });
    expect(report.previousIndexSha256).toBe(sha256Hex(Buffer.from(text)));
    const current = verifyRegistryIndex(
      await readFile(join(root, "next/official-apps.json"), "utf8"),
      trust.registry,
      { official: true, now },
    );
    expect(current.revoked).toEqual(previous.revoked);
    await writeFile(
      join(root, "official-apps/notes/public/app.js"),
      'document.body.dataset.fixture = "changed";',
    );
    await buildRelease(plan, join(root, "changed"), evidence());
    await expect(
      signRelease(plan, join(root, "changed"), { ...signing(), previousIndex: text, sequence: 19 }),
    ).rejects.toThrow("immutable");
  });

  it("refuses a revoked current version and an app version rollback", async () => {
    await signed();
    const previous = verifyRegistryIndex(
      await readFile(join(root, "output/official-apps.json"), "utf8"),
      trust.registry,
      { official: true, now },
    );
    previous.revoked = [{ appId: app.id, version: "1.0.0", reason: "Unsafe fixture version" }];
    let text = signRegistryIndex(previous, registry.privateKey, { official: true });
    await buildRelease(plan, join(root, "revoked"), evidence());
    await expect(
      signRelease(plan, join(root, "revoked"), { ...signing(), previousIndex: text, sequence: 18 }),
    ).rejects.toThrow("revoked");
    previous.revoked = [];
    text = signRegistryIndex(previous, registry.privateKey, { official: true });
    manifest.version = "0.9.0";
    await writeFile(manifestFile(), JSON.stringify(manifest));
    await buildRelease(plan, join(root, "rollback"), evidence());
    await expect(
      signRelease(plan, join(root, "rollback"), {
        ...signing(),
        previousIndex: text,
        sequence: 18,
      }),
    ).rejects.toThrow("rollback");
  });

  it("downloads only a valid pinned previous index and never forwards the API credential to assets", async () => {
    await signed();
    const text = await readFile(join(root, "output/official-apps.json"), "utf8");
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: new Headers(init?.headers) });
      return Promise.resolve(
        url.includes("api.github.com")
          ? Response.json({
              assets: [
                {
                  name: "official-apps.json",
                  browser_download_url:
                    "https://github.com/goktugcy/everyos/releases/download/v1/official-apps.json",
                },
              ],
            })
          : new Response(text),
      );
    };
    expect(await previousOfficialIndex("fixture-token", fetcher, trust.registry)).toBe(text);
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer fixture-token");
    expect(calls[1]!.headers.has("Authorization")).toBe(false);
    await expect(previousOfficialIndex("fixture-token", fetcher)).rejects.toThrow("bad-signature");
  });

  it("distinguishes a first release from GitHub failures or an unexpected download host", async () => {
    const absent: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }));
    expect(await previousOfficialIndex(undefined, absent)).toBeNull();
    const unavailable: typeof fetch = () => Promise.resolve(new Response(null, { status: 503 }));
    await expect(previousOfficialIndex(undefined, unavailable)).rejects.toThrow("HTTP 503");
    const noIndex: typeof fetch = () => Promise.resolve(Response.json({ assets: [] }));
    expect(await previousOfficialIndex(undefined, noIndex)).toBeNull();
    const malicious: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          assets: [
            {
              name: "official-apps.json",
              browser_download_url: "https://example.com/official-apps.json",
            },
          ],
        }),
      );
    await expect(previousOfficialIndex(undefined, malicious)).rejects.toThrow("Unexpected");
  });
});
