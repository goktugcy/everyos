import type { Database } from "@everyos/database";
import { TWO_FACTOR_POLICIES, type TwoFactorPolicy } from "@everyos/shared";
import type { User } from "../users/user-repository.ts";

const KEY = "security.twoFactor";

/** Who must use two-factor authentication; "nobody" until an administrator says otherwise. */
export function readTwoFactorPolicy(db: Database): TwoFactorPolicy {
  const row = db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", KEY);
  if (!row) return "nobody";
  const value = (JSON.parse(row.value) as { required?: unknown }).required;
  return TWO_FACTOR_POLICIES.includes(value as TwoFactorPolicy)
    ? (value as TwoFactorPolicy)
    : "nobody";
}

export function writeTwoFactorPolicy(db: Database, required: TwoFactorPolicy, now: number): void {
  db.run(
    `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    KEY,
    JSON.stringify({ required }),
    now,
  );
}

/** The policy covers this account's role. */
export function policyCovers(policy: TwoFactorPolicy, user: Pick<User, "role">): boolean {
  return policy === "everyone" || (policy === "admins" && user.role === "admin");
}

/** The account must set up two-factor authentication before doing anything else. */
export function needsTwoFactorSetup(
  db: Database,
  user: Pick<User, "role" | "totpEnabled">,
): boolean {
  return !user.totpEnabled && policyCovers(readTwoFactorPolicy(db), user);
}
