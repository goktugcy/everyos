import { createHash } from "node:crypto";
import { z } from "zod";
import { keyFingerprint } from "../packages/app-package/src/index.ts";
import { CommunityPublicKey } from "../packages/app-registry/src/index.ts";
import { createCatalogFetcher, type CatalogFetcher } from "../packages/catalogs/src/fetch.ts";
import { checkCommunityIndex, COMMUNITY_ORIGIN } from "./community-release-gate.ts";

const Health = z.strictObject({ status: z.literal("ok"), environment: z.literal("production") });
const Identity = z.strictObject({
  publicKey: CommunityPublicKey,
  fingerprint: z.string(),
  indexUrl: z.literal(`${COMMUNITY_ORIGIN}/index.json`),
  environment: z.literal("production"),
});

export class CommunityDeploymentError extends Error {
  readonly check: string;
  constructor(check: string) {
    super(`Community deployment check failed: ${check}`);
    this.name = "CommunityDeploymentError";
    this.check = check;
  }
}

/** Read-only verification; this never approves submissions or produces live lifecycle acceptance. */
export async function inspectCommunityDeployment(
  trustedPublicKey: string,
  options: { fetcher?: CatalogFetcher; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const fetcher =
    options.fetcher ??
    createCatalogFetcher({
      allowRedirects: false,
      maxTotalBytes: 12 * 1024 * 1024 + 4096,
      deadlineMs: 30_000,
    });
  let check = "trusted-public-key";
  try {
    const fingerprint = keyFingerprint(CommunityPublicKey.parse(trustedPublicKey));
    check = "service-health";
    Health.parse(
      JSON.parse((await fetcher.get(`${COMMUNITY_ORIGIN}/health`, 512)).toString("utf8")),
    );
    check = "registry-identity";
    const identity = Identity.parse(
      JSON.parse(
        (await fetcher.get(`${COMMUNITY_ORIGIN}/.well-known/everyos-registry`, 2048)).toString(
          "utf8",
        ),
      ),
    );
    if (identity.fingerprint !== fingerprint || keyFingerprint(identity.publicKey) !== fingerprint)
      throw new Error("identity-mismatch");
    check = "published-public-key";
    const publishedKey = (await fetcher.get(`${COMMUNITY_ORIGIN}/registry.pub`, 512)).toString(
      "utf8",
    );
    if (keyFingerprint(CommunityPublicKey.parse(publishedKey)) !== fingerprint)
      throw new Error("public-key-mismatch");
    check = "signed-catalog";
    const bytes = await fetcher.get(`${COMMUNITY_ORIGIN}/index.json`, 12 * 1024 * 1024);
    const index = checkCommunityIndex(
      { url: `${COMMUNITY_ORIGIN}/index.json`, publicKey: trustedPublicKey },
      bytes.toString("utf8"),
      now,
    );
    if (index.registry.id !== "community") throw new Error("wrong-registry");
    return {
      format: "everyos-community-deployment-verification/1",
      status: "passed",
      origin: COMMUNITY_ORIGIN,
      registryFingerprint: fingerprint,
      verifiedAt: new Date(now).toISOString(),
      checks: {
        productionHealth: "passed",
        registryIdentity: "passed",
        publicKey: "passed",
        signedCatalog: "passed",
      },
      catalog: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sequence: index.sequence,
        publishedAt: index.publishedAt,
        expiresAt: index.expiresAt,
        publishers: index.publishers.length,
        apps: index.apps.length,
        revocations: index.revoked.length,
      },
      lifecycleAcceptance: "required",
    } as const;
  } catch {
    throw new CommunityDeploymentError(check);
  }
}
