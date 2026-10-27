import { createPublicKey } from "node:crypto";
import { parseManifest } from "@everyos/app-manifest/schema";
import { keyFingerprint } from "@everyos/app-package";
import {
  CommunityPublicKey,
  REGISTRY_FORMAT,
  RegistryRevocationSchema,
  signRegistryIndex,
  type RegistryApp,
  type RegistryIndex,
} from "@everyos/app-registry";
import { z } from "zod";
import { artifactKey, stmt, type Artifact, type Publisher, type Submission } from "./storage.ts";

export function registryIdentity(env: Env) {
  const publicKey = createPublicKey(env.REGISTRY_PRIVATE_KEY)
    .export({ type: "spki", format: "pem" })
    .toString();
  return { publicKey, fingerprint: keyFingerprint(publicKey) };
}
interface State {
  revision: number;
  updated_at: number;
  object_key: string | null;
  expires_at: number;
}
type Published = Submission & {
  published_at: number;
  manifest_json: string;
  signature: string;
  size: number;
};

/** Immutable snapshots plus a conditional pointer prevent an older signer rolling back the catalog. */
export async function publishIndex(env: Env): Promise<number> {
  const result = await env.DB.batch([
    stmt(env, "SELECT * FROM registry_state WHERE id = 1"),
    stmt(env, "SELECT id, name, keys_json FROM publishers WHERE active = 1 ORDER BY id"),
    stmt(
      env,
      `SELECT s.*, v.published_at, a.manifest_json, a.signature, a.size
      FROM versions v JOIN submissions s ON s.id = v.submission_id
      JOIN artifacts a ON a.publisher_id = s.publisher_id AND a.hash = s.package_hash
      JOIN publishers p ON p.id = s.publisher_id WHERE p.active = 1 ORDER BY s.app_id, s.version`,
    ),
    stmt(env, "SELECT app_id AS appId, version, reason FROM revocations ORDER BY app_id, version"),
  ]);
  const state = result[0]!.results[0] as State;
  const publishers = result[1]!.results as unknown as Publisher[];
  const versions = result[2]!.results as unknown as Published[];
  const revoked = z.array(RegistryRevocationSchema).parse(result[3]!.results);
  const apps = new Map<string, RegistryApp>();
  const heads = new Set<string>();
  for (const row of versions) {
    heads.add(artifactKey("package", row.package_hash));
    heads.add(artifactKey("image", row.icon_hash));
    const screenshots = z.array(z.string()).parse(JSON.parse(row.screenshots_json));
    for (const hash of screenshots) heads.add(artifactKey("image", hash));
    let app = apps.get(row.app_id);
    if (!app) {
      app = {
        id: row.app_id,
        publisher: row.publisher_id,
        icon: `images/${row.icon_hash}`,
        screenshots: screenshots.map((hash) => `images/${hash}`),
        versions: [],
      };
      apps.set(row.app_id, app);
    }
    // The newest review chooses store assets; every published package remains immutable.
    const previousTime = Math.max(0, ...app.versions.map((version) => version.publishedAt));
    if (row.published_at >= previousTime) {
      app.icon = `images/${row.icon_hash}`;
      app.screenshots = screenshots.map((hash) => `images/${hash}`);
    }
    app.versions.push({
      version: row.version,
      manifest: parseManifest(JSON.parse(row.manifest_json)),
      package: {
        url: `packages/${row.package_hash}`,
        size: row.size,
        sha256: row.package_hash,
        signature: row.signature,
      },
      changelog: row.changelog,
      publishedAt: row.published_at,
    });
  }
  // Keep R2 head requests bounded rather than issuing one unbounded fan-out.
  for (const key of heads)
    if (!(await env.ARTIFACTS.head(key))) throw new Error("Missing published artifact");
  const index: RegistryIndex = {
    format: REGISTRY_FORMAT,
    schemaVersion: 1,
    registry: { id: "community", name: "EveryOS Community", homepage: env.PUBLIC_ORIGIN },
    sequence: state.revision,
    publishedAt: state.updated_at,
    expiresAt: state.updated_at + 30 * 86400000,
    publishers: publishers.map((p) => ({
      id: p.id,
      name: p.name,
      keys: z.array(CommunityPublicKey).parse(JSON.parse(p.keys_json)),
    })),
    apps: [...apps.values()],
    revoked,
  };
  const signed = signRegistryIndex(index, env.REGISTRY_PRIVATE_KEY, { official: false });
  const key = `indexes/${state.revision}.json`;
  await env.ARTIFACTS.put(key, signed, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  await stmt(
    env,
    `UPDATE registry_state SET published_revision = ?, object_key = ?, expires_at = ?
    WHERE id = 1 AND published_revision < ?`,
    state.revision,
    key,
    index.expiresAt,
    state.revision,
  ).run();
  return state.revision;
}
export async function publicArtifact(env: Env, kind: Artifact["kind"], hash: string) {
  const rows = await stmt(
    env,
    `SELECT s.* FROM versions v JOIN submissions s ON s.id = v.submission_id
    JOIN publishers p ON p.id = s.publisher_id WHERE p.active = 1 AND NOT EXISTS
    (SELECT 1 FROM revocations r WHERE r.app_id = s.app_id AND (r.version = s.version OR r.version = '*'))
    AND ${kind === "package" ? "s.package_hash = ?" : "(s.icon_hash = ? OR EXISTS (SELECT 1 FROM json_each(s.screenshots_json) WHERE value = ?))"}`,
    ...(kind === "package" ? [hash] : [hash, hash]),
  ).all<Submission>();
  return rows.results.length > 0;
}
