import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/** What a publisher signs: the package's identity and exact bytes. */
export interface PackageDigest {
  appId: string;
  version: string;
  /** Lowercase hex SHA-256 of the `.eosapp` file. */
  sha256: string;
  size: number;
}

const FORMAT = "everyos-app-package/1";

/** Canonical bytes of a digest (fixed key order), so signer and verifier sign the same thing. */
export function packageStatement(digest: PackageDigest): Buffer {
  if (!/^[a-f0-9]{64}$/.test(digest.sha256)) throw new Error("Invalid package digest");
  if (!Number.isSafeInteger(digest.size) || digest.size <= 0) throw new Error("Invalid size");
  return Buffer.from(
    JSON.stringify({
      format: FORMAT,
      appId: digest.appId,
      version: digest.version,
      sha256: digest.sha256,
      size: digest.size,
    }),
  );
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ed25519Public(publicKey: string) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Publisher keys must be Ed25519");
  return key;
}

/** Base64 Ed25519 signature of the digest's statement. */
export function signPackage(digest: PackageDigest, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Publisher keys must be Ed25519");
  return sign(null, packageStatement(digest), key).toString("base64");
}

export function verifyPackage(
  digest: PackageDigest,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== signatureBase64) return false;
  return verify(null, packageStatement(digest), ed25519Public(publicKeyPem), signature);
}

/** `sha256:<hex>` of the key's SubjectPublicKeyInfo: what people compare to trust a key. */
export function keyFingerprint(publicKeyPem: string): string {
  const der = ed25519Public(publicKeyPem).export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function generatePublisherKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
