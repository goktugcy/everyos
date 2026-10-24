import { mkdir, readFile, writeFile } from "node:fs/promises";
import { previousOfficialIndex } from "./previous-official-apps.ts";
import { generatePublisherKeys } from "../packages/app-package/src/index.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildRelease,
  loadReleasePlan,
  RELEASE_TRUST,
  runAppTests,
  signRelease,
  verifyRelease,
} from "./official-apps-release.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: "string" },
      sequence: { type: "string" },
      "previous-index": { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0];
  if (values.help) {
    console.log(
      "Usage: node scripts/official-apps.ts <check|build|previous|sign|verify> [--out directory] [--sequence integer] [--previous-index file]",
    );
    console.log(
      "check uses ephemeral keys; sign reads the protected release environment; verify requires the pinned production keys.",
    );
    return;
  }
  if (
    positionals.length !== 1 ||
    !["check", "build", "previous", "sign", "verify"].includes(command ?? "")
  )
    throw new Error("Choose check, build, previous, sign or verify; use --help for usage");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (command === "previous") {
    const file = resolve(root, values.out ?? "dist/previous-official-apps.json");
    const index = await previousOfficialIndex(process.env.GH_TOKEN);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, index ?? "null\n", { flag: "wx" });
    console.log(JSON.stringify({ previousIndex: index !== null, file }));
    return;
  }
  const plan = await loadReleasePlan(root);
  const out = resolve(
    root,
    values.out ?? (command === "check" ? "dist/official-apps-check" : "dist/official-apps"),
  );
  if (command === "verify") {
    const report = await verifyRelease(plan, out);
    console.log(
      JSON.stringify({
        status: report.status,
        mode: report.mode,
        apps: report.apps.length,
        source: report.source.commit,
      }),
    );
    return;
  }
  if (command === "sign") {
    if (
      process.env.CI !== "true" ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_REF_TYPE !== "tag"
    )
      throw new Error("Production signing runs only in the protected tag-release workflow");
    const registryPrivateKey = process.env.EVERYOS_APP_REGISTRY_PRIVATE_KEY;
    const publisherPrivateKey = process.env.EVERYOS_APP_PUBLISHER_PRIVATE_KEY;
    if (!registryPrivateKey || !publisherPrivateKey)
      throw new Error("Both protected app-signing secrets are required");
    if (
      !values.sequence ||
      !/^[1-9][0-9]*$/.test(values.sequence) ||
      !Number.isSafeInteger(Number(values.sequence))
    )
      throw new Error("Signing requires a positive safe --sequence integer");
    if (!values["previous-index"]) throw new Error("Signing requires the previous-index receipt");
    const previous = await readFile(resolve(root, values["previous-index"]), "utf8");
    const report = await signRelease(plan, out, {
      registryPrivateKey,
      publisherPrivateKey,
      trust: RELEASE_TRUST,
      mode: "release",
      sequence: Number(values.sequence),
      ...(previous.trim() === "null" ? {} : { previousIndex: previous }),
    });
    console.log(
      JSON.stringify({
        status: report.status,
        mode: report.mode,
        apps: report.apps.length,
        source: report.source.commit,
      }),
    );
    return;
  }
  if (values.sequence) throw new Error("--sequence is used only by sign");
  if (command === "build" && plan.source.dirty)
    throw new Error(
      "A production candidate requires a clean source checkout; use check during development",
    );
  const tests = await runAppTests(plan);
  let report = await buildRelease(plan, out, tests);
  if (command === "check") {
    const registry = generatePublisherKeys();
    const publisher = generatePublisherKeys();
    report = await signRelease(plan, out, {
      registryPrivateKey: registry.privateKey,
      publisherPrivateKey: publisher.privateKey,
      trust: { registry: registry.publicKey, publisher: publisher.publicKey },
      mode: "development",
      sequence: 1,
    });
  }
  console.log(
    JSON.stringify({
      status: report.status,
      mode: report.mode,
      apps: report.apps.length,
      tests: report.apps.reduce((sum, app) => sum + app.tests.assertions, 0),
      out,
    }),
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Official app release failed");
  process.exitCode = 1;
});
