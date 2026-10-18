import { hostname } from "node:os";
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from "@everyos/auth";
import { type RecoveryCodesResponse, type TotpEnrollmentResponse } from "@everyos/shared";
import {
  ChangePasswordRequestSchema,
  PasswordConfirmationSchema,
  TotpDisableRequestSchema,
  TotpEnableRequestSchema,
  UpdateAccountRequestSchema,
} from "@everyos/shared/schemas";
import { LinuxUnlockSchema } from "@everyos/shared/schemas";
import { callAgent } from "../../http/agent.ts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, AuthState } from "../../context.ts";
import { ApiError, rateLimited } from "../../http/errors.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { confirmPassword as confirmPasswordFor } from "../../http/reauth.ts";
import { authenticated, requireAuth } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { assertPasswordPolicy, pendingTotpContext, totpContext } from "../auth/password-policy.ts";
import { policyCovers, readTwoFactorPolicy } from "../auth/two-factor-policy.ts";
import { toPublicUser } from "../users/user-repository.ts";

export function accountRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { users, audit, secrets, limiters } = services;
  app.use("*", authenticated);

  const emptyLinuxInput = z.strictObject({});
  app.get("/linux", async (c) => {
    parseQuery(c, emptyLinuxInput);
    return c.json(await callAgent(c, services, "identity.status", {}));
  });
  app.post("/linux/unlock", async (c) => {
    const body = await parseJsonBody(c, LinuxUnlockSchema);
    const status = await callAgent(c, services, "identity.unlock", body);
    const auth = requireAuth(c);
    audit.record({
      action: "account.linux.unlock",
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      details: {
        account: status.account?.name,
        duration: body.duration ?? "legacy-session",
        expiresAt: status.privilegedUntil,
        scope: status.privilegeScope,
      },
    });
    return c.json(status);
  });
  app.post("/linux/lock", async (c) => {
    parseQuery(c, emptyLinuxInput);
    // Older clients send a bodyless POST; supplied bodies must still be strict empty objects.
    if ((await c.req.raw.clone().text()).length > 0) await parseJsonBody(c, emptyLinuxInput);
    await callAgent(c, services, "identity.lock", { scope: "account" });
    const auth = requireAuth(c);
    audit.record({
      action: "account.linux.lock",
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
    });
    return c.body(null, 204);
  });

  const actor = (auth: AuthState) => ({ userId: auth.user.id, username: auth.user.username });

  const confirmPassword = (c: Context<AppEnv>, auth: AuthState, password: string, action: string) =>
    confirmPasswordFor(services, c, auth, password, action);

  function confirmTotp(c: Context<AppEnv>, auth: AuthState, code: string, action: string): void {
    const key = `user:${auth.user.id}`;
    const decision = limiters.sensitiveUser.check(key);
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);
    const sealed = auth.user.totpSecretEnc;
    const step = sealed
      ? verifyTotp(secrets.open(sealed, totpContext(auth.user.id)), code, services.now(), {
          lastUsedStep: auth.user.totpLastStep,
        })
      : null;
    if (step === null) {
      limiters.sensitiveUser.recordFailure(key);
      audit.record({
        action,
        outcome: "failure",
        actor: actor(auth),
        ip: c.get("client").ip,
        details: { reason: "bad-totp" },
      });
      throw new ApiError(400, "AUTH_TOTP_INVALID", "Invalid verification code");
    }
    users.setTotpLastStep(auth.user.id, step);
  }

  function issueRecoveryCodes(userId: string): string[] {
    const codes = generateRecoveryCodes();
    users.replaceRecoveryCodes(userId, codes.map(hashRecoveryCode));
    return codes;
  }

  app.patch("/", async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, UpdateAccountRequestSchema);
    users.update(auth.user.id, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
    });
    return c.json(toPublicUser(users.findById(auth.user.id)!));
  });

  app.post("/password", async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, ChangePasswordRequestSchema);
    await confirmPassword(c, auth, body.currentPassword, "account.password.change");
    assertPasswordPolicy(body.newPassword, auth.user.username);
    users.setPasswordHash(auth.user.id, await services.passwords.hash(body.newPassword));
    const revoked = services.sessions.revokeAllForUser(auth.user.id, auth.session.id);
    audit.record({
      action: "account.password.change",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
      details: { revokedSessions: revoked },
    });
    return c.body(null, 204);
  });

  app.post("/totp/enroll", (c) => {
    const auth = requireAuth(c);
    if (auth.user.totpEnabled)
      throw new ApiError(409, "TOTP_ALREADY_ENABLED", "TOTP is already enabled");
    const secret = generateTotpSecret();
    users.setPendingTotpSecret(
      auth.user.id,
      secrets.seal(secret, pendingTotpContext(auth.user.id)),
    );
    const response: TotpEnrollmentResponse = {
      secret,
      otpauthUri: buildOtpauthUri({
        secret,
        issuer: "EveryOS",
        accountName: `${auth.user.username}@${hostname()}`,
      }),
    };
    return c.json(response);
  });

  app.post("/totp/enable", async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, TotpEnableRequestSchema);
    if (auth.user.totpEnabled)
      throw new ApiError(409, "TOTP_ALREADY_ENABLED", "TOTP is already enabled");
    if (!auth.user.totpPendingSecretEnc)
      throw new ApiError(400, "TOTP_ENROLLMENT_MISSING", "No pending enrollment");
    const key = `user:${auth.user.id}`;
    const decision = limiters.sensitiveUser.check(key);
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);

    const secret = secrets.open(auth.user.totpPendingSecretEnc, pendingTotpContext(auth.user.id));
    const step = verifyTotp(secret, body.code, services.now());
    if (step === null) {
      limiters.sensitiveUser.recordFailure(key);
      throw new ApiError(400, "AUTH_TOTP_INVALID", "Invalid verification code");
    }
    const recoveryCodes = services.db.transaction(() => {
      users.enableTotp(auth.user.id, secrets.seal(secret, totpContext(auth.user.id)), step);
      return issueRecoveryCodes(auth.user.id);
    });
    audit.record({
      action: "account.totp.enable",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
    });
    const response: RecoveryCodesResponse = { recoveryCodes };
    return c.json(response);
  });

  app.post("/totp/disable", async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, TotpDisableRequestSchema);
    if (!auth.user.totpEnabled) throw new ApiError(409, "TOTP_NOT_ENABLED", "TOTP is not enabled");
    if (policyCovers(readTwoFactorPolicy(services.db), auth.user))
      throw new ApiError(409, "TWO_FACTOR_ENFORCED", "Two-factor authentication is required");
    await confirmPassword(c, auth, body.password, "account.totp.disable");
    confirmTotp(c, auth, body.code, "account.totp.disable");
    users.disableTotp(auth.user.id);
    audit.record({
      action: "account.totp.disable",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
    });
    return c.body(null, 204);
  });

  app.post("/recovery-codes", async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, PasswordConfirmationSchema);
    if (!auth.user.totpEnabled) throw new ApiError(409, "TOTP_NOT_ENABLED", "TOTP is not enabled");
    await confirmPassword(c, auth, body.password, "account.recovery-codes.regenerate");
    const recoveryCodes = issueRecoveryCodes(auth.user.id);
    audit.record({
      action: "account.recovery-codes.regenerate",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
    });
    const response: RecoveryCodesResponse = { recoveryCodes };
    return c.json(response);
  });

  return app;
}
