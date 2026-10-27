import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { appBelongsTo, compareVersions, isReservedNamespace } from "@everyos/app-manifest";
import { verifyPackage } from "@everyos/app-package";
import {
  MAX_INDEX_BYTES,
  RegistryIndexSchema,
  SignedIndexSchema,
  type RegistryApp,
  type RegistryIndex,
  type RegistryRevocation,
  type RegistryVersion,
} from "./index-schema.ts";

export type RegistryErrorCode =
  "too-large" | "invalid-format" | "bad-signature" | "expired" | "rollback" | "invalid-index";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  constructor(code: RegistryErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RegistryError";
    this.code = code;
  }
}

export interface VerifyIndexOptions {
  /** Only the pinned official registry may list `dev.everyos.*` and other reserved names. */
  official: boolean;
  now?: number;
  allowExpired?: boolean;
  /** The highest sequence accepted before from this registry. */
  minSequence?: number;
}

function ed25519(keyPem: string, kind: "public" | "private") {
  const key = kind === "public" ? createPublicKey(keyPem) : createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new RegistryError("invalid-format", "key type");
  return key;
}

/** Cross-entry rules a per-field schema cannot express. */
function checkConsistency(index: RegistryIndex, official: boolean): void {
  const fail = (detail: string): never => {
    throw new RegistryError("invalid-index", detail);
  };
  const publishers = new Map(index.publishers.map((publisher) => [publisher.id, publisher]));
  if (publishers.size !== index.publishers.length) fail("duplicate publisher");
  for (const publisher of index.publishers) {
    if (!official && isReservedNamespace(publisher.id)) fail(`reserved namespace ${publisher.id}`);
    // Nested namespaces would make an app id belong to two publishers.
    for (const other of index.publishers)
      if (other !== publisher && appBelongsTo(other.id, publisher.id))
        fail(`nested namespace ${other.id}`);
  }
  const apps = new Set<string>();
  for (const app of index.apps) {
    if (apps.has(app.id)) fail(`duplicate app ${app.id}`);
    apps.add(app.id);
    const publisher = publishers.get(app.publisher) ?? fail(`unknown publisher of ${app.id}`);
    if (!appBelongsTo(app.id, publisher.id)) fail(`${app.id} outside ${publisher.id}`);
    const versions = new Set<string>();
    for (const entry of app.versions) {
      if (versions.has(entry.version)) fail(`duplicate version ${app.id}@${entry.version}`);
      versions.add(entry.version);
      const { manifest } = entry;
      if (
        manifest.id !== app.id ||
        manifest.version !== entry.version ||
        manifest.publisher.id !== app.publisher
      )
        fail(`manifest of ${app.id}@${entry.version} does not match its entry`);
      const digest = {
        appId: app.id,
        version: entry.version,
        sha256: entry.package.sha256,
        size: entry.package.size,
      };
      if (!publisher.keys.some((key) => verifyPackage(digest, entry.package.signature, key)))
        fail(`package signature of ${app.id}@${entry.version}`);
    }
  }
}

/**
 * Verifies a signed index with the registry's key and returns it. The signature, freshness,
 * rollback and every publisher, namespace and package signature are checked; any problem rejects
 * the whole index (a registry is trusted as a unit).
 */
export function verifyRegistryIndex(
  text: string,
  registryKeyPem: string,
  options: VerifyIndexOptions,
): RegistryIndex {
  if (Buffer.byteLength(text) > Math.ceil((MAX_INDEX_BYTES * 4) / 3) + 1024)
    throw new RegistryError("too-large");
  let envelope;
  try {
    envelope = SignedIndexSchema.parse(JSON.parse(text));
  } catch {
    throw new RegistryError("invalid-format", "not a signed index");
  }
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  if (!verify(null, payload, ed25519(registryKeyPem, "public"), signature))
    throw new RegistryError("bad-signature");
  let index: RegistryIndex;
  try {
    index = RegistryIndexSchema.parse(JSON.parse(payload.toString("utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "invalid";
    throw new RegistryError("invalid-index", message);
  }
  const now = options.now ?? Date.now();
  if (index.publishedAt > now + 5 * 60_000 || index.expiresAt <= index.publishedAt)
    throw new RegistryError("invalid-index", "timestamps");
  if (!options.allowExpired && index.expiresAt <= now) throw new RegistryError("expired");
  if (options.minSequence !== undefined && index.sequence < options.minSequence)
    throw new RegistryError("rollback", `${index.sequence} < ${options.minSequence}`);
  checkConsistency(index, options.official);
  return index;
}

/** Signs an index (after validating it exactly as clients will) into its published JSON form. */
export function signRegistryIndex(
  index: RegistryIndex,
  registryPrivateKeyPem: string,
  options: { official: boolean },
): string {
  const parsed = RegistryIndexSchema.parse(index);
  checkConsistency(parsed, options.official);
  const payload = Buffer.from(JSON.stringify(parsed));
  if (payload.length > MAX_INDEX_BYTES) throw new RegistryError("too-large");
  const signature = sign(null, payload, ed25519(registryPrivateKeyPem, "private"));
  return `${JSON.stringify({ payload: payload.toString("base64"), signature: signature.toString("base64") })}\n`;
}

export function revocationOf(
  index: Pick<RegistryIndex, "revoked">,
  appId: string,
  version: string,
): RegistryRevocation | null {
  return (
    index.revoked.find(
      (entry) => entry.appId === appId && (entry.version === "*" || entry.version === version),
    ) ?? null
  );
}

/** The newest version that is not revoked (pre-releases only when asked for). */
export function latestVersion(
  index: Pick<RegistryIndex, "revoked">,
  app: RegistryApp,
  includePrerelease = false,
): RegistryVersion | null {
  return (
    app.versions
      .filter(
        (entry) =>
          (includePrerelease || !entry.version.includes("-")) &&
          !revocationOf(index, app.id, entry.version),
      )
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}
