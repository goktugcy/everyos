import { createHmac, randomBytes } from "node:crypto";
import { base32Decode, base32Encode } from "./base32.ts";

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 s step, 6 digits),
 * the profile supported by every mainstream authenticator app.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export interface TotpOptions {
  periodSeconds?: number;
  digits?: number;
}

export function generateTotpSecret(): string {
  // 160 bits, the RFC 4226 recommended secret length for HMAC-SHA1.
  return base32Encode(randomBytes(20));
}

export function timeStep(nowMs: number, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / periodSeconds);
}

/** HOTP value (RFC 4226) for a counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function generateTotp(
  secretBase32: string,
  nowMs: number,
  options: TotpOptions = {},
): string {
  const step = timeStep(nowMs, options.periodSeconds);
  return hotp(base32Decode(secretBase32), step, options.digits);
}

export interface TotpVerifyOptions extends TotpOptions {
  /** Accept codes from this many steps before/after now (clock skew). */
  window?: number;
  /**
   * The last time step that was accepted for this secret. Codes at or before
   * this step are rejected so an observed code cannot be replayed.
   */
  lastUsedStep?: number | null;
}

/**
 * Returns the matched time step, or null. Callers must persist the returned
 * step as the new `lastUsedStep`.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  options: TotpVerifyOptions = {},
): number | null {
  const digits = options.digits ?? TOTP_DIGITS;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = timeStep(nowMs, options.periodSeconds);
  const window = options.window ?? 1;
  let matched: number | null = null;
  // Evaluate every candidate so timing does not depend on which step matched.
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    if (hotp(secret, step, digits) === code && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (
    options.lastUsedStep !== undefined &&
    options.lastUsedStep !== null &&
    matched <= options.lastUsedStep
  ) {
    return null;
  }
  return matched;
}

export interface OtpauthUriInput {
  secret: string;
  accountName: string;
  issuer: string;
}

export function buildOtpauthUri({ secret, accountName, issuer }: OtpauthUriInput): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
