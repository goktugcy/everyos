import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isPublisherId } from "@everyos/app-manifest";
import { inspectPackage, keyFingerprint, sha256Hex, verifyPackage } from "@everyos/app-package";
import {
  REGISTRY_FORMAT,
  signRegistryIndex,
  verifyRegistryIndex,
  type RegistryIndex,
} from "@everyos/app-registry";
import { keygen, publicKeyOf, readPrivateKey, signPackageFile } from "./keys.ts";
import { CliError } from "./project.ts";

/*
 * Your own registry: a directory of static files (index.json, packages/, icons/) that any web
 * server can host (a VPS, object storage, GitHub Pages). EveryOS adds it as a source with its URL,
 * the registry's public key and fingerprint; every package in it carries your publisher signature.
 * Nothing here ever publishes to the official EveryOS registry.
 */

/** How long a published index stays valid; refresh it before (`everyos-app registry refresh`). */
export const INDEX_LIFETIME_MS = 180 * 86_400_000;

export interface RegistryPaths {
  dir: string;
  /** Registry private key (signs the index). */
  key: string;
  /** Publisher private key (signs packages). */
  publisherKey: string;
}

async function readIndex(paths: RegistryPaths): Promise<RegistryIndex> {
  const file = join(paths.dir, "index.json");
  if (!existsSync(file))
    throw new CliError(`No registry in ${paths.dir}: create one with "everyos-app registry init"`);
  const publicKey = await publicKeyOf(paths.key);
  return verifyRegistryIndex(await readFile(file, "utf8"), publicKey, {
    official: false,
    allowExpired: true,
  });
}

async function writeIndex(paths: RegistryPaths, index: RegistryIndex, now: number): Promise<void> {
  const next = {
    ...index,
    sequence: index.sequence + 1,
    publishedAt: now,
    expiresAt: now + INDEX_LIFETIME_MS,
  };
  const text = signRegistryIndex(next, await readPrivateKey(paths.key), { official: false });
  await writeFile(join(paths.dir, "index.json"), text);
}

/** Creates the registry (and its keys, when missing) with you as its publisher. */
export async function initRegistry(
  paths: RegistryPaths,
  options: { id: string; name: string; publisherId: string; publisherName: string },
  now = Date.now(),
): Promise<{ publicKey: string; fingerprint: string }> {
  if (existsSync(join(paths.dir, "index.json")))
    throw new CliError(`${paths.dir} already holds a registry`);
  const publisherId: string = options.publisherId;
  if (!isPublisherId(options.publisherId))
    throw new CliError(`"${publisherId}" is not a publisher id (like com.example)`);
  for (const key of [paths.key, paths.publisherKey])
    if (!existsSync(key)) await keygen(key.replace(/\.key$/, ""));
  await mkdir(join(paths.dir, "packages"), { recursive: true });
  await mkdir(join(paths.dir, "icons"), { recursive: true });
  const index: RegistryIndex = {
    format: REGISTRY_FORMAT,
    schemaVersion: 1,
    registry: { id: options.id, name: options.name },
    // writeIndex raises it to 1.
    sequence: 0,
    publishedAt: now,
    expiresAt: now + INDEX_LIFETIME_MS,
    publishers: [
      {
        id: options.publisherId,
        name: options.publisherName,
        keys: [await publicKeyOf(paths.publisherKey)],
      },
    ],
    apps: [],
    revoked: [],
  };
  await writeIndex(paths, index, now);
  const publicKey = await publicKeyOf(paths.key);
  await writeFile(join(paths.dir, "registry.pub"), publicKey);
  return { publicKey, fingerprint: keyFingerprint(publicKey) };
}

/**
 * Adds a package to the registry: signs it with the publisher key, copies it and its icon, lists
 * the version (newest first) and signs the index again. A published version never changes.
 */
export async function publishPackage(
  paths: RegistryPaths,
  packageFile: string,
  options: { changelog?: string; iconFile?: string } = {},
  now = Date.now(),
): Promise<{ appId: string; version: string; sequence: number }> {
  const index = await readIndex(paths);
  const bytes = await readFile(packageFile);
  const { manifest } = await inspectPackage(bytes);
  const publisher = index.publishers.find((entry) => entry.id === manifest.publisher.id);
  if (!publisher)
    throw new CliError(
      `This registry has no publisher ${manifest.publisher.id} (the manifest's publisher.id)`,
    );
  const signature = await signPackageFile(packageFile, paths.publisherKey);
  if (!publisher.keys.some((key) => verifyPackage(signature, signature.signature, key)))
    throw new CliError("The publisher key is not one of the publisher's keys in this registry");
  const name = `${manifest.id}-${manifest.version}.eosapp`;
  const app = index.apps.find((entry) => entry.id === manifest.id);
  const existing = app?.versions.find((entry) => entry.version === manifest.version);
  if (existing) {
    if (existing.package.sha256 !== sha256Hex(bytes))
      throw new CliError(
        `${manifest.id} ${manifest.version} is already published with other bytes: raise the version`,
      );
    return { appId: manifest.id, version: manifest.version, sequence: index.sequence };
  }
  await mkdir(join(paths.dir, "packages"), { recursive: true });
  await copyFile(packageFile, join(paths.dir, "packages", name));
  let icon = app?.icon;
  if (options.iconFile) {
    await mkdir(join(paths.dir, "icons"), { recursive: true });
    icon = `icons/${manifest.id}${extname(options.iconFile).toLowerCase()}`;
    await copyFile(options.iconFile, join(paths.dir, icon));
  }
  if (!icon) throw new CliError("The first publication of an app needs its icon");
  const version = {
    version: manifest.version,
    manifest,
    package: {
      url: `packages/${name}`,
      size: bytes.length,
      sha256: signature.sha256,
      signature: signature.signature,
    },
    ...(options.changelog ? { changelog: options.changelog.slice(0, 8000) } : {}),
    publishedAt: now,
  };
  const apps = app
    ? index.apps.map((entry) =>
        entry.id === manifest.id
          ? { ...entry, icon: icon, versions: [version, ...entry.versions].slice(0, 50) }
          : entry,
      )
    : [
        ...index.apps,
        {
          id: manifest.id,
          publisher: manifest.publisher.id,
          icon,
          screenshots: [],
          versions: [version],
        },
      ];
  await writeIndex(paths, { ...index, apps }, now);
  return { appId: manifest.id, version: manifest.version, sequence: index.sequence + 1 };
}

/** Signs the index again with a later expiry (and a higher sequence). */
export async function refreshRegistry(paths: RegistryPaths, now = Date.now()): Promise<number> {
  const index = await readIndex(paths);
  await writeIndex(paths, index, now);
  return index.sequence + 1;
}

/** Revokes a version (or `*`, every version): installed copies are turned off on their next sync. */
export async function revokeVersion(
  paths: RegistryPaths,
  appId: string,
  version: string,
  reason: string,
  now = Date.now(),
): Promise<void> {
  const index = await readIndex(paths);
  if (!index.apps.some((app) => app.id === appId))
    throw new CliError(`No app ${appId} in this registry`);
  const revoked = [
    ...index.revoked.filter((entry) => !(entry.appId === appId && entry.version === version)),
    { appId, version, reason },
  ];
  await writeIndex(paths, { ...index, revoked }, now);
}
