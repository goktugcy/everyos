import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@otuken/shared";
import { normalizePassword } from "./password.ts";

export type PasswordPolicyViolation =
  "too-short" | "too-long" | "contains-username" | "too-common" | "repetitive";

/**
 * Small deny-list of very common passwords that satisfy the length rule.
 * Shorter common passwords are already rejected by the minimum length.
 */
const COMMON_PASSWORDS = new Set([
  "1234567890",
  "0123456789",
  "1234567891",
  "12345678910",
  "123456789012",
  "123456789a",
  "a123456789",
  "1234567890a",
  "qwertyuiop",
  "qwertyuiop1",
  "qwerty1234",
  "qwerty12345",
  "1q2w3e4r5t",
  "q1w2e3r4t5",
  "1qaz2wsx3edc",
  "zaq12wsxcde",
  "asdfghjkl1",
  "password12",
  "password123",
  "password1234",
  "passw0rd123",
  "p@ssw0rd123",
  "administrator",
  "admin12345",
  "admin123456",
  "welcome123",
  "letmein123",
  "iloveyou12",
  "football123",
  "abc1234567",
  "abcdefghij",
  "changeme123",
  "raspberry123",
  "raspberrypi",
  "otuken1234",
  "otukenadmin",
  "sifre12345",
  "sifre123456",
  "parola1234",
  "parola12345",
  "galatasaray",
  "fenerbahce",
  "besiktas1903",
  "trabzonspor",
]);

export interface PasswordPolicyContext {
  username?: string;
}

export function checkPasswordPolicy(
  password: string,
  context: PasswordPolicyContext = {},
): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) violations.push("too-short");
  if (length > PASSWORD_MAX_LENGTH) violations.push("too-long");

  const lower = normalized.toLocaleLowerCase("en-US");
  const username = context.username?.toLocaleLowerCase("en-US");
  if (username && username.length >= 3 && lower.includes(username))
    violations.push("contains-username");
  if (COMMON_PASSWORDS.has(lower)) violations.push("too-common");
  if (new Set(normalized).size <= 2) violations.push("repetitive");
  return violations;
}
