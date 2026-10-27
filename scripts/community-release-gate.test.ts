import { describe, expect, it } from "vitest";
import { generatePublisherKeys, keyFingerprint } from "../packages/app-package/src/index.ts";
import { signRegistryIndex } from "../packages/app-registry/src/index.ts";
import {
  checkCommunityIndex,
  checkCommunityRelease,
  COMMUNITY_ORIGIN,
  LEGACY_COMMUNITY_ORIGIN,
} from "./community-release-gate.ts";

const key = generatePublisherKeys();
const now = Date.parse("2026-10-25T12:00:00Z");
const anchor = { url: COMMUNITY_ORIGIN + "/index.json", publicKey: key.publicKey };
const evidence = {
  format: "everyos-community-live-acceptance/1",
  everyosVersion: "0.1.37",
  origin: COMMUNITY_ORIGIN,
  registryFingerprint: keyFingerprint(key.publicKey),
  verifiedAt: new Date(now).toISOString(),
  evidenceUrl: "https://github.com/goktugcy/everyos/actions/runs/123",
  live: true,
  checks: Object.fromEntries(
    ["enrollment", "submission", "humanReview", "installation", "update", "revocation"].map(
      (name) => [name, "passed"],
    ),
  ),
};
describe("Community public release gate", () => {
  it("blocks an undeployed registry regardless of local test results", () => {
    expect(() => checkCommunityRelease(null, evidence, "0.1.37", now)).toThrow("absent");
  });
  it("requires live complete evidence for the exact candidate and pinned key", () => {
    expect(() => checkCommunityRelease(anchor, evidence, "0.1.37", now)).not.toThrow();
    for (const changed of [
      { live: false },
      { everyosVersion: "0.1.36" },
      { registryFingerprint: "sha256:" + "0".repeat(64) },
      { verifiedAt: "2026-09-01T12:00:00Z" },
      { verifiedAt: "2026-11-01T12:00:00Z" },
      { checks: { ...evidence.checks, revocation: "pending" } },
    ])
      expect(() =>
        checkCommunityRelease(anchor, { ...evidence, ...changed }, "0.1.37", now),
      ).toThrow();
    expect(() =>
      checkCommunityRelease({ ...anchor, allowPrivate: true }, evidence, "0.1.37", now),
    ).toThrow("endpoint");
  });
  it("retains historical lifecycle evidence only with a fresh verified migration of the same key", () => {
    const legacy = { ...evidence, origin: LEGACY_COMMUNITY_ORIGIN };
    const migration = {
      format: "everyos-community-origin-migration/1",
      from: LEGACY_COMMUNITY_ORIGIN,
      to: COMMUNITY_ORIGIN,
      registryFingerprint: evidence.registryFingerprint,
      verifiedAt: evidence.verifiedAt,
      evidenceUrl: "https://github.com/goktugcy/everyos/blob/main/docs/evidence/migration.json",
      checks: {
        legacyEndpoint: "passed",
        newEndpoint: "passed",
        sameSigningKey: "passed",
        sameSignedCatalog: "passed",
      },
    };
    expect(() => checkCommunityRelease(anchor, legacy, "0.1.37", now)).toThrow("migration");
    expect(() =>
      checkCommunityRelease(anchor, { ...legacy, originMigration: migration }, "0.1.37", now),
    ).not.toThrow();
    for (const changed of [
      { from: "https://unrelated.example" },
      { to: "https://unrelated.example" },
      { registryFingerprint: "sha256:" + "0".repeat(64) },
      { verifiedAt: "2026-09-01T12:00:00Z" },
      { verifiedAt: "2026-11-01T12:00:00Z" },
      { checks: { ...migration.checks, sameSignedCatalog: "pending" } },
    ])
      expect(() =>
        checkCommunityRelease(
          anchor,
          { ...legacy, originMigration: { ...migration, ...changed } },
          "0.1.37",
          now,
        ),
      ).toThrow();
  });
  it("requires the live index to have a valid current signature", () => {
    const index = signRegistryIndex(
      {
        format: "everyos-app-registry",
        schemaVersion: 1,
        registry: { id: "community", name: "Community" },
        sequence: 1,
        publishedAt: now - 1000,
        expiresAt: now + 60000,
        publishers: [],
        apps: [],
        revoked: [],
      },
      key.privateKey,
      { official: false },
    );
    expect(() => checkCommunityIndex(anchor, index, now)).not.toThrow();
    expect(() =>
      checkCommunityIndex({ ...anchor, publicKey: generatePublisherKeys().publicKey }, index, now),
    ).toThrow("bad-signature");
    expect(() => checkCommunityIndex(anchor, index, now + 60001)).toThrow("expired");
  });
  it("refuses a private key accidentally supplied as the built-in trust anchor", () => {
    expect(() =>
      checkCommunityRelease({ ...anchor, publicKey: key.privateKey }, evidence, "0.1.37", now),
    ).toThrow("only a public key");
  });
});
