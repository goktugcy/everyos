import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, sign } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePublisherKeys } from "../packages/app-package/src/index.ts";
import {
  SDK_PACKAGES,
  signSdkDistribution,
  verifySdkDistribution,
  type SdkReport,
} from "./sdk-distribution.ts";

let dir: string;
let report: SdkReport;
const save = () => writeFile(join(dir, "sdk-report.json"), JSON.stringify(report) + "\n");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "everyos-sdk-verification-"));
  const packages = [];
  for (const item of SDK_PACKAGES) {
    const name = item.slug === "create-everyos-app" ? item.slug : "@everyos/" + item.slug;
    const file = name.replace(/^@/, "").replace("/", "-") + "-1.0.0.tgz";
    const bytes = Buffer.from("Archive integrity fixture: " + name);
    await writeFile(join(dir, file), bytes);
    packages.push({
      name,
      version: "1.0.0",
      file,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    });
  }
  report = {
    format: "everyos-sdk-distribution/1",
    source: { commit: "a".repeat(40), dirty: false, everyosVersion: "0.1.37" },
    sdkVersion: "1.0.0",
    packages,
  };
  await save();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe("Standalone SDK artifact integrity", () => {
  it("checks all five exact package identities, versions and both digests", async () => {
    expect(await verifySdkDistribution(dir)).toEqual(report);
    await writeFile(join(dir, report.packages[0]!.file), "tampered");
    await expect(verifySdkDistribution(dir)).rejects.toThrow("differs");
  });
  it.each(["missing", "duplicate", "version", "path", "extra"])(
    "rejects %s artifacts",
    async (change) => {
      if (change === "missing") await rm(join(dir, report.packages[0]!.file));
      if (change === "duplicate") report.packages[1] = report.packages[0]!;
      if (change === "version") report.packages[0]!.version = "2.0.0";
      if (change === "path") report.packages[0]!.file = "../outside.tgz";
      if (change === "extra") await writeFile(join(dir, "private-key.pem"), "must never ship");
      await save();
      await expect(verifySdkDistribution(dir)).rejects.toThrow();
    },
  );
  it("rejects report and archive symlinks", async () => {
    const file = join(dir, report.packages[0]!.file);
    await rm(file);
    await symlink(join(dir, "sdk-report.json"), file);
    await expect(verifySdkDistribution(dir)).rejects.toThrow("without links");
  });
  it("verifies a domain-separated release signature against an independently trusted key", async () => {
    const key = generatePublisherKeys();
    await signSdkDistribution(dir, key.privateKey);
    expect(await verifySdkDistribution(dir, key.publicKey)).toEqual(report);
    await expect(verifySdkDistribution(dir, generatePublisherKeys().publicKey)).rejects.toThrow(
      "signature",
    );
    // An ordinary file signature cannot be replayed as an SDK distribution signature.
    const bytes = await readFile(join(dir, "sdk-report.json"));
    await writeFile(join(dir, "sdk-report.sig"), sign(null, bytes, key.privateKey));
    await expect(verifySdkDistribution(dir, key.publicKey)).rejects.toThrow("signature");
  });
});
