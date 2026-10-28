/** Attest actual baseline/candidate bytes with a fresh test key; never use production secrets. */
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { SignedReleaseSchema, verifyRelease } from "../../packages/release/src/manifest.ts";
import { EVERYOS_VERSION } from "../../packages/shared/src/index.ts";

const root = resolve(import.meta.dirname, "../..");
const prior = join(root, "dist/sdk-linux-prior");
const directory = join(root, "dist/sdk-linux-candidate");
await mkdir(directory, { recursive: true });
const envelope = SignedReleaseSchema.parse(
  JSON.parse(await readFile(join(prior, "release.json"), "utf8")),
);
const baseline = verifyRelease(
  JSON.stringify(envelope),
  await readFile(join(prior, "everyos-release-public.pem"), "utf8"),
);
if (baseline.version !== "0.1.36") throw new Error("Unexpected baseline release");
const key = generateKeyPairSync("ed25519").privateKey;
const keyFile = join(directory, "test.key");
await writeFile(keyFile, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
await writeFile(
  join(root, "dist/packages/signed-prior.json"),
  JSON.stringify({
    ...envelope,
    signature: sign(null, Buffer.from(envelope.payload, "base64"), key).toString("base64"),
  }),
);
await promisify(execFile)(
  process.execPath,
  [
    "scripts/sign-release.ts",
    "--version",
    EVERYOS_VERSION,
    "--min-version",
    "0.1.0",
    "--key-file",
    keyFile,
  ],
  { cwd: root },
);
console.log("Ephemeral package qualification metadata prepared");
