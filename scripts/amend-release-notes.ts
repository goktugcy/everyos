import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  packageDigest,
  ReleaseManifestSchema,
  verifyRelease,
  type ReleaseManifest,
} from "../packages/release/src/manifest.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    manifest: { type: "string" },
    "public-key": { type: "string" },
    notes: { type: "string" },
    key: { type: "string" },
    out: { type: "string" },
    receipt: { type: "string" },
    verify: { type: "string" },
  },
});
const required = (name: keyof typeof values): string => {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
const version = ReleaseManifestSchema.shape.version.parse(required("version"));
const source = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
assert.equal(source.version, version, "Amend only the current source release");
const originalBytes = readFileSync(required("manifest"));
const publicKey = readFileSync(required("public-key"), "utf8");
const original = verifyRelease(originalBytes.toString("utf8"), publicKey);
assert.equal(original.version, version, "Release version mismatch");
const lines = readFileSync(required("notes"), "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`EveryOS ${version} `));
assert(start >= 0, "The notes document has no section for this release");
const end = lines.findIndex((line, index) => index > start && /^EveryOS \d+\.\d+\.\d+ /.test(line));
const notes = lines
  .slice(start, end < 0 ? undefined : end)
  .join("\n")
  .trim();
assert(notes.length > 0, "Release notes cannot be empty");
const check = (amended: ReleaseManifest) => {
  assert.equal(amended.notes, notes, "Published notes do not match the reviewed source");
  // A note correction must not change package hashes, compatibility, timestamps or expiry.
  assert.deepEqual({ ...amended, notes: original.notes }, original, "Release identity changed");
};

if (values.verify) {
  check(verifyRelease(readFileSync(values.verify, "utf8"), publicKey));
  process.stdout.write(
    JSON.stringify({ status: "passed", version, packagesUnchanged: true }) + "\n",
  );
} else {
  assert.notEqual(notes, original.notes, "The signed notes already match the reviewed source");
  const key = createPrivateKey(readFileSync(required("key")));
  assert.equal(key.asymmetricKeyType, "ed25519", "Release key must be Ed25519");
  assert.deepEqual(
    createPublicKey(key).export({ format: "der", type: "spki" }),
    createPublicKey(publicKey).export({ format: "der", type: "spki" }),
    "The signing key does not match the existing release key",
  );
  const payload = Buffer.from(JSON.stringify(ReleaseManifestSchema.parse({ ...original, notes })));
  const amendedBytes = Buffer.from(
    JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, key).toString("base64"),
    }) + "\n",
  );
  check(verifyRelease(amendedBytes.toString("utf8"), publicKey));
  writeFileSync(required("out"), amendedBytes, { mode: 0o600, flag: "wx" });
  const receipt = {
    version,
    originalSha256: packageDigest(originalBytes),
    amendedSha256: packageDigest(amendedBytes),
    notesSha256: packageDigest(Buffer.from(notes)),
    notesSourceCommit: process.env["GITHUB_SHA"] ?? null,
    packagesUnchanged: true,
    timestampsUnchanged: true,
  };
  writeFileSync(required("receipt"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(JSON.stringify(receipt) + "\n");
}
