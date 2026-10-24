import {
  compactVerify,
  createLocalJWKSet,
  errors,
  importJWK,
  importSPKI,
  importX509,
  type JWK,
  type JSONWebKeySet,
} from "jose";

/*
 * JSON Web Tokens, read and checked on this device only. Decoding never needs a key; signatures
 * are checked against a key the person pastes (never fetched), and tokens are never sent anywhere.
 */

export type DecodeProblem = "empty" | "segments" | "base64" | "json" | "jwe" | "not-object";

export interface Decoded {
  header: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  /** The payload when it is not JSON (JWS can sign any bytes). */
  payloadText: string | null;
  signature: string;
  parts: [string, string, string];
}

export type DecodeResult =
  { ok: true; token: Decoded } | { ok: false; problem: DecodeProblem; part?: number };

function base64UrlBytes(part: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  const base64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function json(
  part: string,
  index: number,
): { value: unknown } | { problem: DecodeProblem; part: number } {
  const bytes = base64UrlBytes(part);
  if (!bytes) return { problem: "base64", part: index };
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { problem: "json", part: index };
  }
}

export function decode(input: string): DecodeResult {
  const token = input.trim().replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, problem: "empty" };
  const parts = token.split(".");
  if (parts.length === 5) return { ok: false, problem: "jwe" };
  if (parts.length !== 3) return { ok: false, problem: "segments" };
  const [rawHeader = "", rawPayload = "", signature = ""] = parts;
  const header = json(rawHeader, 0);
  if ("problem" in header) return { ok: false, problem: header.problem, part: 0 };
  if (!header.value || typeof header.value !== "object" || Array.isArray(header.value))
    return { ok: false, problem: "not-object", part: 0 };
  if (!base64UrlBytes(signature)) return { ok: false, problem: "base64", part: 2 };
  const payloadBytes = base64UrlBytes(rawPayload);
  if (!payloadBytes) return { ok: false, problem: "base64", part: 1 };
  const payload = json(rawPayload, 1);
  const parsed =
    "value" in payload &&
    payload.value &&
    typeof payload.value === "object" &&
    !Array.isArray(payload.value)
      ? (payload.value as Record<string, unknown>)
      : null;
  return {
    ok: true,
    token: {
      header: header.value as Record<string, unknown>,
      payload: parsed,
      payloadText: parsed ? null : new TextDecoder().decode(payloadBytes),
      signature,
      parts: [rawHeader, rawPayload, signature],
    },
  };
}

/* ------------------------------------------------------------------ claims */

export const REGISTERED_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "azp",
  "scope",
  "scp",
  "client_id",
  "sid",
  "nonce",
  "auth_time",
  "acr",
  "amr",
  "name",
  "given_name",
  "family_name",
  "preferred_username",
  "email",
  "email_verified",
  "phone_number",
  "roles",
  "groups",
  "tid",
  "oid",
] as const;

export const TIME_CLAIMS = ["exp", "nbf", "iat", "auth_time"] as const;

/** Claims about the person, redacted by default when exporting. */
export const PERSONAL_CLAIMS = [
  "sub",
  "name",
  "given_name",
  "family_name",
  "preferred_username",
  "email",
  "phone_number",
  "address",
  "birthdate",
  "oid",
  "sid",
  "nonce",
] as const;

export type Validity =
  | { state: "valid"; expiresIn: number | null }
  | { state: "expired"; ago: number }
  | { state: "not-yet"; in: number }
  | { state: "no-expiry" };

/** Whether the token is within exp and nbf (seconds of `skew` tolerated). */
export function validity(
  payload: Record<string, unknown> | null,
  nowMs: number,
  skew = 0,
): Validity {
  const now = nowMs / 1000;
  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  const nbf = typeof payload?.nbf === "number" ? payload.nbf : null;
  if (nbf !== null && now + skew < nbf) return { state: "not-yet", in: nbf - now };
  if (exp !== null && now - skew >= exp) return { state: "expired", ago: now - exp };
  if (exp === null) return { state: "no-expiry" };
  return { state: "valid", expiresIn: exp - now };
}

export function redact(
  payload: Record<string, unknown>,
  claims: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, claims.has(key) ? "[redacted]" : value]),
  );
}

/* ------------------------------------------------------------------ signatures */

export type SecretEncoding = "text" | "base64" | "base64url";

export type VerifyResult =
  | "valid"
  | "invalid-signature"
  | "alg-none"
  | "alg-unsupported"
  | "key-mismatch"
  | "bad-key"
  | "private-key"
  | "no-matching-key";

const SUPPORTED = /^(HS|RS|PS|ES)(256|384|512)$|^EdDSA$|^Ed25519$/;

/** The JWK key type each algorithm family needs. */
function keyTypeFor(alg: string): string {
  return alg.startsWith("RS") || alg.startsWith("PS") ? "RSA" : alg.startsWith("ES") ? "EC" : "OKP";
}

/** Whether a PEM key that `alg` refused is a valid key of another kind. */
async function otherKind(pem: string, certificate: boolean, alg: string): Promise<boolean> {
  for (const candidate of ["RS256", "ES256", "ES384", "ES512", "EdDSA"]) {
    if (keyTypeFor(candidate) === keyTypeFor(alg)) continue;
    try {
      await (certificate ? importX509(pem, candidate) : importSPKI(pem, candidate));
      return true;
    } catch {
      // Not this kind either.
    }
  }
  return false;
}

function secretBytes(secret: string, encoding: SecretEncoding): Uint8Array {
  if (encoding === "text") return new TextEncoder().encode(secret);
  const bytes = base64UrlBytes(
    encoding === "base64"
      ? secret.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      : secret.trim(),
  );
  if (!bytes) throw new TypeError("bad-secret");
  return bytes;
}

/**
 * Checks the signature with the key the person gave: an HMAC secret, a PEM public key or
 * certificate, a JWK, or a JWK set (picked by kid). Expiry is not part of this check.
 */
export async function verify(
  token: string,
  key: string,
  encoding: SecretEncoding = "text",
): Promise<VerifyResult> {
  const decoded = decode(token);
  if (!decoded.ok) return "invalid-signature";
  const alg = typeof decoded.token.header.alg === "string" ? decoded.token.header.alg : "";
  if (alg.toLowerCase() === "none") return "alg-none";
  if (!SUPPORTED.test(alg)) return "alg-unsupported";
  const compact = decoded.token.parts.join(".");
  const material = key.trim();
  if (/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(material)) return "private-key";
  try {
    if (alg.startsWith("HS")) {
      if (/^-----BEGIN|^\s*\{/.test(material)) return "key-mismatch";
      await compactVerify(compact, secretBytes(key, encoding), { algorithms: [alg] });
      return "valid";
    }
    const certificate = material.startsWith("-----BEGIN CERTIFICATE-----");
    if (certificate || material.startsWith("-----BEGIN PUBLIC KEY-----")) {
      let imported: Awaited<ReturnType<typeof importSPKI>>;
      try {
        imported = await (certificate ? importX509(material, alg) : importSPKI(material, alg));
      } catch {
        return (await otherKind(material, certificate, alg)) ? "key-mismatch" : "bad-key";
      }
      await compactVerify(compact, imported, { algorithms: [alg] });
      return "valid";
    }
    const parsed = JSON.parse(material) as JWK | JSONWebKeySet;
    if ("keys" in parsed && Array.isArray(parsed.keys)) {
      await compactVerify(compact, createLocalJWKSet(parsed), { algorithms: [alg] });
      return "valid";
    }
    const jwk = parsed as JWK;
    if (jwk.d) return "private-key";
    if (jwk.kty && jwk.kty !== keyTypeFor(alg)) return "key-mismatch";
    await compactVerify(compact, await importJWK(jwk, alg), { algorithms: [alg] });
    return "valid";
  } catch (error) {
    if (error instanceof errors.JWSSignatureVerificationFailed) return "invalid-signature";
    if (
      error instanceof errors.JWKSNoMatchingKey ||
      error instanceof errors.JWKSMultipleMatchingKeys
    )
      return "no-matching-key";
    if (error instanceof SyntaxError) return "bad-key";
    if (error instanceof TypeError && error.message === "bad-secret") return "bad-key";
    // A key of another type for this algorithm (an EC key for RS256 …).
    if (
      error instanceof TypeError ||
      error instanceof errors.JOSENotSupported ||
      error instanceof errors.JOSEAlgNotAllowed
    )
      return "key-mismatch";
    return "bad-key";
  }
}
