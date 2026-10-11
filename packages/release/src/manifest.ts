import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { ReleaseVersionSchema } from "@everyos/shared/schemas";

const ArtifactSchema = z.strictObject({
  file: z.string().regex(/^everyos_\d+\.\d+\.\d+_(arm64|amd64)\.deb$/),
  size: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ReleaseManifestSchema = z.strictObject({
  format: z.literal("everyos-release"),
  version: ReleaseVersionSchema,
  minVersion: ReleaseVersionSchema,
  schemaVersion: z.number().int().positive(),
  publishedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  notes: z.string().max(8000),
  artifacts: z.strictObject({ arm64: ArtifactSchema, amd64: ArtifactSchema }),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export const SignedReleaseSchema = z.strictObject({
  payload: z
    .string()
    .max(90_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  signature: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export function compareVersions(a: string, b: string): number {
  const left = ReleaseVersionSchema.parse(a).split(".").map(Number);
  const right = ReleaseVersionSchema.parse(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isSafeInteger(left[i]) || !Number.isSafeInteger(right[i]))
      throw new Error("Invalid version");
    const result = left[i]! - right[i]!;
    if (result) return Math.sign(result);
  }
  return 0;
}

export function verifyRelease(
  text: string,
  publicKey: string,
  now = Date.now(),
  allowExpired = false,
): ReleaseManifest {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Release metadata is too large");
  const signed = SignedReleaseSchema.parse(JSON.parse(text));
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
  const payload = Buffer.from(signed.payload, "base64");
  const signature = Buffer.from(signed.signature, "base64");
  if (signature.length !== 64 || !verify(null, payload, key, signature))
    throw new Error("Invalid release signature");
  const manifest = ReleaseManifestSchema.parse(JSON.parse(payload.toString("utf8")));
  if (
    manifest.publishedAt > now + 5 * 60_000 ||
    manifest.expiresAt <= manifest.publishedAt ||
    (!allowExpired && manifest.expiresAt <= now)
  )
    throw new Error("Release metadata is expired or has an invalid timestamp");
  for (const arch of ["arm64", "amd64"] as const)
    if (manifest.artifacts[arch].file !== `everyos_${manifest.version}_${arch}.deb`)
      throw new Error("Release package identity mismatch");
  return manifest;
}

export function packageDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
