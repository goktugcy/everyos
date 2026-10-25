#!/usr/bin/env node
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  buildSdkDistribution,
  signSdkDistribution,
  verifySdkDistribution,
} from "./sdk-distribution.ts";
const root = resolve(import.meta.dirname, "..");
const [command = "build", directory = "dist/sdk", publicKeyFile] = process.argv.slice(2);
const out = resolve(root, directory);
if (command !== "build" && command !== "verify" && command !== "sign")
  throw new Error("sdk.ts build|verify|sign [directory] [trusted-public-key-file]");
if (command === "sign") {
  const privateKey = process.env.EVERYOS_RELEASE_PRIVATE_KEY;
  if (!privateKey) throw new Error("EVERYOS_RELEASE_PRIVATE_KEY is required in the release job");
  await signSdkDistribution(out, privateKey);
  console.log("SDK distribution signed");
  process.exit(0);
}
const report =
  command === "build"
    ? await buildSdkDistribution(root, out)
    : await verifySdkDistribution(
        out,
        publicKeyFile ? await readFile(resolve(publicKeyFile), "utf8") : undefined,
      );
console.log(
  JSON.stringify({
    status: "passed",
    packages: report.packages.length,
    source: report.source,
    files: report.packages.map((pkg) => ({ file: pkg.file, bytes: pkg.size })),
  }),
);
