import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generatePublisherKeys,
  inspectPackage,
  keyFingerprint,
  sha256Hex,
  signPackage,
} from "@everyos/app-package";
import { CliError } from "./project.ts";

/*
 * Ed25519 keys: a publisher key signs packages, a registry key signs a registry's index. Private
 * keys are written once, readable by their owner only, and never leave the developer's machine.
 */

export async function keygen(base: string): Promise<{ publicKey: string; fingerprint: string }> {
  const privatePath = `${base}.key`;
  const publicPath = `${base}.pub`;
  if (existsSync(privatePath) || existsSync(publicPath))
    throw new CliError(`${privatePath} already exists: keys are never overwritten`);
  const keys = generatePublisherKeys();
  await mkdir(dirname(privatePath), { recursive: true, mode: 0o700 });
  await writeFile(privatePath, keys.privateKey, { mode: 0o600, flag: "wx" });
  await writeFile(publicPath, keys.publicKey, { mode: 0o644, flag: "wx" });
  return { publicKey: keys.publicKey, fingerprint: keyFingerprint(keys.publicKey) };
}

export async function readPrivateKey(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new CliError(`Private key not found: ${path} (create one with "everyos-app keygen")`);
  }
}

/** The public key of a private key file's pair (`<name>.pub` next to `<name>.key`). */
export async function publicKeyOf(privatePath: string): Promise<string> {
  const path = privatePath.replace(/\.key$/, ".pub");
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new CliError(`Public key not found: ${path}`);
  }
}

export interface Signature {
  format: "everyos-app-signature/1";
  appId: string;
  version: string;
  sha256: string;
  size: number;
  signature: string;
  publicKey: string;
  fingerprint: string;
}

/** Signs a package's digest with a publisher key (what registries list next to the package). */
export async function signPackageFile(file: string, keyPath: string): Promise<Signature> {
  const bytes = await readFile(file).catch(() => {
    throw new CliError(`Package not found: ${file}`);
  });
  const { manifest } = await inspectPackage(bytes);
  const digest = {
    appId: manifest.id,
    version: manifest.version,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  };
  const publicKey = await publicKeyOf(keyPath);
  const signature: Signature = {
    format: "everyos-app-signature/1",
    ...digest,
    signature: signPackage(digest, await readPrivateKey(keyPath)),
    publicKey,
    fingerprint: keyFingerprint(publicKey),
  };
  await writeFile(`${file}.sig.json`, `${JSON.stringify(signature, null, 2)}\n`);
  return signature;
}
