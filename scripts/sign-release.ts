import { createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ReleaseManifestSchema, packageDigest } from "../packages/release/src/manifest.ts";
import { EVERYOS_MIGRATIONS } from "../packages/database/src/migrations/index.ts";
import { renderBootstrapInstaller } from "./bootstrap-installer.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "min-version": { type: "string", default: "0.1.0" },
    "schema-version": { type: "string" },
    "key-file": { type: "string" },
    "notes-file": { type: "string" },
    directory: { type: "string", default: "dist/packages" },
  },
});
if (!values.version || !values["key-file"])
  throw new Error("--version and --key-file are required");
const key = createPrivateKey(readFileSync(values["key-file"]));
if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 private key is required");
const artifact = (arch: string) => {
  const file = `everyos_${values.version}_${arch}.deb`,
    path = join(values.directory, file);
  return { file, size: statSync(path).size, sha256: packageDigest(readFileSync(path)) };
};
const now = Date.now();
const manifest = ReleaseManifestSchema.parse({
  format: "everyos-release",
  version: values.version,
  minVersion: values["min-version"],
  schemaVersion: values["schema-version"]
    ? Number(values["schema-version"])
    : Math.max(...EVERYOS_MIGRATIONS.map((migration) => migration.version)),
  publishedAt: now,
  expiresAt: now + 90 * 24 * 60 * 60_000,
  notes: values["notes-file"] ? readFileSync(values["notes-file"], "utf8") : "",
  artifacts: { arm64: artifact("arm64"), amd64: artifact("amd64") },
});
const payload = Buffer.from(JSON.stringify(manifest));
writeFileSync(
  join(values.directory, "release.json"),
  JSON.stringify({
    payload: payload.toString("base64"),
    signature: sign(null, payload, key).toString("base64"),
  }) + "\n",
);
const publicKey = createPublicKey(key);
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
writeFileSync(join(values.directory, "everyos-release-public.pem"), publicPem);
const bootstrap = renderBootstrapInstaller(
  readFileSync(new URL("../packaging/bootstrap.sh", import.meta.url), "utf8"),
  readFileSync(new URL("../packaging/install.py", import.meta.url), "utf8"),
  publicPem,
);
writeFileSync(join(values.directory, "install.sh"), bootstrap, { mode: 0o755 });
writeFileSync(join(values.directory, "install.sh.sig"), sign(null, Buffer.from(bootstrap), key));
const fingerprint = createHash("sha256")
  .update(publicKey.export({ format: "der", type: "spki" }))
  .digest("hex");
console.log(`Signed EveryOS ${manifest.version}`);
console.log(`Publisher public key: SHA256:${fingerprint}`);
