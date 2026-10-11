import { randomInt } from "node:crypto";
import { sha256Hex } from "@everyos/security";

// Lowercase alphabet without visually ambiguous characters (0/o, 1/l/i).
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUP_LENGTH = 5;
export const RECOVERY_CODE_COUNT = 10;

function randomGroup(): string {
  let out = "";
  for (let i = 0; i < GROUP_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Generates human-friendly single-use codes such as `k7m2p-xq9rt` (~49 bits each). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(`${randomGroup()}-${randomGroup()}`);
  return [...codes];
}

/** Canonical form used for hashing: lowercase, no separators or whitespace. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]+/g, "");
}

/**
 * Recovery codes are high-entropy random values, so a fast hash is
 * sufficient (no password-style stretching needed).
 */
export function hashRecoveryCode(code: string): string {
  return sha256Hex(`otuken-recovery-v1:${normalizeRecoveryCode(code)}`);
}
