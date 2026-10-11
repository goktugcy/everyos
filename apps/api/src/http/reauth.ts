import type { Context } from "hono";
import type { AppEnv, AuthState } from "../context.ts";
import type { Services } from "../services.ts";
import { ApiError, rateLimited } from "./errors.ts";

/**
 * Re-authentication for sensitive actions (password changes, 2FA changes,
 * restoring or downloading backups), with its own brute-force limit.
 */
export async function confirmPassword(
  services: Services,
  c: Context<AppEnv>,
  auth: AuthState,
  password: string,
  action: string,
): Promise<void> {
  const key = `user:${auth.user.id}`;
  const decision = services.limiters.sensitiveUser.check(key);
  if (!decision.allowed) throw rateLimited(decision.retryAfterMs);
  const { valid } = await services.passwords.verify(password, auth.user.passwordHash);
  if (!valid) {
    services.limiters.sensitiveUser.recordFailure(key);
    services.audit.record({
      action,
      outcome: "failure",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      details: { reason: "bad-password" },
    });
    throw new ApiError(400, "AUTH_CURRENT_PASSWORD_INVALID", "Current password is incorrect");
  }
}
