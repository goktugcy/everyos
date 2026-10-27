import { z } from "zod";
import { keyFingerprint } from "../packages/app-package/src/index.ts";
import { verifyRegistryIndex } from "../packages/app-registry/src/index.ts";
import type { RegistryAnchor } from "../apps/api/src/modules/desktop-apps/anchors.ts";

export const COMMUNITY_ORIGIN = "https://registry.everyos.net";
export const LEGACY_COMMUNITY_ORIGIN = "https://everyos.goktugceyhan.dev";
const passed = z.literal("passed");
const OriginMigration = z.strictObject({
  format: z.literal("everyos-community-origin-migration/1"),
  from: z.literal(LEGACY_COMMUNITY_ORIGIN),
  to: z.literal(COMMUNITY_ORIGIN),
  registryFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
  evidenceUrl: z.url({ protocol: /^https$/ }),
  checks: z.strictObject({
    legacyEndpoint: passed,
    newEndpoint: passed,
    sameSigningKey: passed,
    sameSignedCatalog: passed,
  }),
});
export const CommunityReleaseEvidence = z.strictObject({
  format: z.literal("everyos-community-live-acceptance/1"),
  everyosVersion: z.string(),
  origin: z.enum([COMMUNITY_ORIGIN, LEGACY_COMMUNITY_ORIGIN]),
  registryFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
  evidenceUrl: z.url({ protocol: /^https$/ }),
  live: z.literal(true),
  originMigration: OriginMigration.optional(),
  checks: z.strictObject({
    enrollment: passed,
    submission: passed,
    humanReview: passed,
    installation: passed,
    update: passed,
    revocation: passed,
  }),
});

/** Local workerd tests are intentionally insufficient for a public release. */
export function checkCommunityRelease(
  anchor: RegistryAnchor | null,
  evidence: unknown,
  version: string,
  now = Date.now(),
): void {
  if (!anchor) throw new Error("Release blocked: the deployed community trust anchor is absent");
  if (anchor.url !== COMMUNITY_ORIGIN + "/index.json" || anchor.allowPrivate)
    throw new Error("Release blocked: unexpected community endpoint");
  if (
    !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(
      anchor.publicKey,
    )
  )
    throw new Error("Release blocked: the community anchor must contain only a public key");
  const receipt = CommunityReleaseEvidence.parse(evidence);
  const age = now - Date.parse(receipt.verifiedAt);
  if (
    receipt.everyosVersion !== version ||
    receipt.registryFingerprint !== keyFingerprint(anchor.publicKey) ||
    age < -300000 ||
    age > 30 * 86400000
  )
    throw new Error("Release blocked: live community acceptance does not match this candidate");
  if (receipt.origin !== COMMUNITY_ORIGIN) {
    const migration = receipt.originMigration;
    const migrationAge = migration ? now - Date.parse(migration.verifiedAt) : NaN;
    if (
      !migration ||
      migration.registryFingerprint !== receipt.registryFingerprint ||
      migrationAge < -300000 ||
      migrationAge > 30 * 86400000 ||
      !Number.isFinite(migrationAge)
    )
      throw new Error("Release blocked: community origin migration is not verified");
  }
}

export function checkCommunityIndex(anchor: RegistryAnchor, text: string, now = Date.now()) {
  return verifyRegistryIndex(text, anchor.publicKey, { official: false, now });
}
