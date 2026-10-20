import { isAppId, isPublisherId, isVersion } from "@everyos/app-manifest";
import { AppManifestSchema } from "@everyos/app-manifest/schema";
import { z } from "zod";

/*
 * A registry index: the signed list of publishers (with the keys that own their namespaces), apps,
 * versions and revocations. EveryOS trusts an app version only through this chain: registry key →
 * index → publisher key → package signature → package bytes.
 */

export const REGISTRY_FORMAT = "everyos-app-registry";
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;

const text = (max: number) => z.string().min(1).max(max);
/** An https URL, or a path relative to the index URL (`packages/notes-1.0.0.eosapp`). */
const resource = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      (/^https:\/\/\S+$/.test(value) && URL.canParse(value)) ||
      /^(?!\/)(?!.*\.\.)[A-Za-z0-9._~/@+-]+$/.test(value),
    { message: "invalid-resource" },
  );
const publicKey = z
  .string()
  .max(512)
  .regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/);

export const RegistryPackageSchema = z.strictObject({
  url: resource,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Base64 Ed25519 signature of the package digest by a key of the app's publisher. */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

export const RegistryVersionSchema = z.strictObject({
  version: z.string().refine(isVersion, { message: "invalid-version" }),
  manifest: AppManifestSchema,
  package: RegistryPackageSchema,
  changelog: z.string().max(8000).optional(),
  publishedAt: z.number().int().nonnegative(),
});

export const RegistryAppSchema = z.strictObject({
  id: z.string().refine(isAppId, { message: "invalid-app-id" }),
  publisher: z.string().refine(isPublisherId, { message: "invalid-publisher-id" }),
  screenshots: z.array(resource).max(8).default([]),
  versions: z.array(RegistryVersionSchema).min(1).max(50),
});

export const RegistryPublisherSchema = z.strictObject({
  id: z.string().refine(isPublisherId, { message: "invalid-publisher-id" }),
  name: text(64),
  url: z.string().max(512).optional(),
  /** Keys that may sign this publisher's packages (key rotation keeps the old one for a while). */
  keys: z.array(publicKey).min(1).max(4),
});

export const RegistryRevocationSchema = z.strictObject({
  appId: z.string().refine(isAppId, { message: "invalid-app-id" }),
  /** A version, or `*` for every version of the app. */
  version: z.union([z.literal("*"), z.string().refine(isVersion)]),
  reason: text(500),
});

export const RegistryIndexSchema = z.strictObject({
  format: z.literal(REGISTRY_FORMAT),
  schemaVersion: z.literal(1),
  registry: z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
    name: text(64),
    homepage: z.string().max(512).optional(),
  }),
  /** Grows with every publication; a client never accepts a lower one (rollback protection). */
  sequence: z.number().int().nonnegative(),
  publishedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  publishers: z.array(RegistryPublisherSchema).max(5000),
  apps: z.array(RegistryAppSchema).max(5000),
  revoked: z.array(RegistryRevocationSchema).max(20_000),
});

export const SignedIndexSchema = z.strictObject({
  payload: z
    .string()
    .max(Math.ceil((MAX_INDEX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;
export type RegistryApp = z.infer<typeof RegistryAppSchema>;
export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;
export type RegistryPublisher = z.infer<typeof RegistryPublisherSchema>;
export type RegistryRevocation = z.infer<typeof RegistryRevocationSchema>;
