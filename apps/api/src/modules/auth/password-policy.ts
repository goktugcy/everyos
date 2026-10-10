import { checkPasswordPolicy } from "@otuken/auth";
import { ApiError } from "../../http/errors.ts";

/** Throws AUTH_PASSWORD_POLICY with the list of violations for the UI. */
export function assertPasswordPolicy(password: string, username: string): void {
  const violations = checkPasswordPolicy(password, { username });
  if (violations.length > 0) {
    throw new ApiError(400, "AUTH_PASSWORD_POLICY", "Password does not satisfy the policy", {
      details: { violations },
    });
  }
}

export const totpContext = (userId: string) => `user:${userId}:totp`;
export const pendingTotpContext = (userId: string) => `user:${userId}:totp-pending`;
