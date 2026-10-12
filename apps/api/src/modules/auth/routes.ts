import { hashRecoveryCode, verifyTotp } from "@everyos/auth";
import { type LoginResponse } from "@everyos/shared";
import {
  EmptyDesktopQuerySchema,
  LoginRequestSchema,
  LoginTotpRequestSchema,
  UnlockRequestSchema,
} from "@everyos/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError, notFound, rateLimited } from "../../http/errors.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { totpContext } from "./password-policy.ts";
import { buildSessionInfo, clearSessionCookie, startSession } from "./session-cookie.ts";

const invalidCredentials = () =>
  new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Invalid username or password");
const challengeExpired = () =>
  new ApiError(401, "AUTH_CHALLENGE_EXPIRED", "Login challenge expired");

export function authRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { limiters, audit } = services;

  app.post("/login", async (c) => {
    const body = await parseJsonBody(c, LoginRequestSchema);
    const client = c.get("client");
    const ipKey = `ip:${client.ip}`;
    const userKey = `user:${body.username}`;
    for (const [limiter, key] of [
      [limiters.loginIp, ipKey],
      [limiters.loginUser, userKey],
    ] as const) {
      const decision = limiter.check(key);
      if (!decision.allowed) {
        audit.record({
          action: "auth.login",
          outcome: "denied",
          ip: client.ip,
          target: body.username,
          details: { reason: "rate-limited" },
        });
        throw rateLimited(decision.retryAfterMs);
      }
    }

    const fail = (reason: string): never => {
      const ipLocked = limiters.loginIp.recordFailure(ipKey);
      const userLocked = limiters.loginUser.recordFailure(userKey);
      // Lockouts can mean password guessing: tell the people who read the audit log.
      if (ipLocked || userLocked)
        services.notifications.publish({
          kind: "login-locked",
          severity: "warning",
          key: userLocked ? `user:${body.username}` : `ip:${client.ip}`,
          params: {
            username: body.username.slice(0, 64),
            ip: client.ip,
            scope: userLocked ? "user" : "ip",
          },
        });
      audit.record({
        action: "auth.login",
        outcome: "failure",
        ip: client.ip,
        target: body.username,
        details: { reason },
      });
      throw invalidCredentials();
    };

    const user = services.users.findByUsername(body.username);
    if (!user) {
      await services.passwords.dummyVerify();
      return fail("unknown-user");
    }
    const verification = await services.passwords.verify(body.password, user.passwordHash);
    if (!verification.valid) return fail("bad-password");
    if (user.disabled) {
      audit.record({
        action: "auth.login",
        outcome: "denied",
        ip: client.ip,
        target: user.username,
        details: { reason: "disabled" },
      });
      throw new ApiError(403, "AUTH_ACCOUNT_DISABLED", "Account is disabled");
    }
    if (verification.needsRehash) {
      services.users.setPasswordHash(user.id, await services.passwords.hash(body.password), {
        rehashOnly: true,
      });
    }
    limiters.loginUser.reset(userKey);

    if (user.totpEnabled) {
      const challenge = services.challenges.create(user.id, client.ip);
      const response: LoginResponse = {
        status: "totp_required",
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt,
      };
      return c.json(response);
    }
    const session = startSession(c, services, user);
    audit.record({
      action: "auth.login",
      outcome: "success",
      actor: { userId: user.id, username: user.username },
      ip: client.ip,
    });
    const response: LoginResponse = { status: "authenticated", session };
    return c.json(response);
  });

  app.post("/login/totp", async (c) => {
    const body = await parseJsonBody(c, LoginTotpRequestSchema);
    const client = c.get("client");
    const ipKey = `ip:${client.ip}`;
    const decision = limiters.loginIp.check(ipKey);
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);

    const challenge = services.challenges.get(body.challengeId, client.ip);
    if (!challenge) throw challengeExpired();
    const user = services.users.findById(challenge.userId);
    if (!user || user.disabled || !user.totpEnabled || !user.totpSecretEnc) {
      services.challenges.delete(challenge.id);
      throw challengeExpired();
    }

    let method: "totp" | "recovery-code";
    let verified = false;
    if (body.code !== undefined) {
      method = "totp";
      const secret = services.secrets.open(user.totpSecretEnc, totpContext(user.id));
      const step = verifyTotp(secret, body.code, services.now(), {
        lastUsedStep: user.totpLastStep,
      });
      if (step !== null) {
        services.users.setTotpLastStep(user.id, step);
        verified = true;
      }
    } else {
      method = "recovery-code";
      verified = services.users.consumeRecoveryCode(
        user.id,
        hashRecoveryCode(body.recoveryCode ?? ""),
      );
    }

    if (!verified) {
      services.challenges.recordFailure(challenge.id);
      limiters.loginIp.recordFailure(ipKey);
      audit.record({
        action: "auth.login.second-factor",
        outcome: "failure",
        ip: client.ip,
        target: user.username,
        details: { method },
      });
      throw new ApiError(401, "AUTH_TOTP_INVALID", "Invalid verification code");
    }
    services.challenges.delete(challenge.id);
    const session = startSession(c, services, user);
    audit.record({
      action: "auth.login",
      outcome: "success",
      actor: { userId: user.id, username: user.username },
      ip: client.ip,
      details: {
        secondFactor: method,
        ...(method === "recovery-code"
          ? { recoveryCodesLeft: services.users.remainingRecoveryCodes(user.id) }
          : {}),
      },
    });
    const response: LoginResponse = { status: "authenticated", session };
    return c.json(response);
  });

  app.post("/logout", async (c) => {
    const auth = c.get("auth");
    if (auth) {
      services.sessions.revoke(auth.session.id);
      if (services.config.mode === "production")
        await services.agent
          .call("identity.lock", { scope: "session" }, agentActor(auth, c.get("client").ip))
          .catch(() => undefined);
      audit.record({
        action: "auth.logout",
        outcome: "success",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
      });
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post("/lock", requirePermission("preferences:manage"), async (c) => {
    const auth = requireAuth(c);
    parseQuery(c, EmptyDesktopQuerySchema);
    // The Node adapter exposes a stream even for a bodyless POST.
    if ((await c.req.text()).length > 0)
      throw new ApiError(400, "VALIDATION_FAILED", "Lock request does not accept a body");
    services.sessions.lock(auth.session.id);
    if (services.config.mode === "production")
      await services.agent
        .call("identity.lock", { scope: "session" }, agentActor(auth, c.get("client").ip))
        .catch(() => undefined);
    audit.record({
      action: "auth.session.lock",
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
    });
    return c.body(null, 204);
  });

  app.post("/unlock", requirePermission("preferences:manage"), async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, UnlockRequestSchema);
    const actor = { userId: auth.user.id, username: auth.user.username };
    const key = `user:${auth.user.id}`;
    const decision = limiters.sensitiveUser.check(key);
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);
    const { valid } = await services.passwords.verify(body.password, auth.user.passwordHash);
    if (!valid) {
      limiters.sensitiveUser.recordFailure(key);
      audit.record({
        action: "auth.session.unlock",
        outcome: "failure",
        actor,
        ip: c.get("client").ip,
      });
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Invalid password");
    }
    limiters.sensitiveUser.reset(key);
    services.sessions.unlock(auth.session.id);
    audit.record({
      action: "auth.session.unlock",
      outcome: "success",
      actor,
      ip: c.get("client").ip,
    });
    return c.json(buildSessionInfo(services, auth.user, { ...auth.session, lockedAt: null }));
  });

  app.get("/session", (c) => {
    const auth = requireAuth(c);
    return c.json(buildSessionInfo(services, auth.user, auth.session));
  });

  app.get("/sessions", (c) => {
    const auth = requireAuth(c);
    return c.json({ sessions: services.sessions.listForUser(auth.user.id, auth.session.id) });
  });

  app.delete("/sessions/:id", (c) => {
    const auth = requireAuth(c);
    const id = c.req.param("id");
    if (!services.sessions.revokeForUser(auth.user.id, id)) throw notFound("Session");
    audit.record({
      action: "auth.session.revoke",
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target: id,
    });
    if (id === auth.session.id) clearSessionCookie(c);
    return c.body(null, 204);
  });

  return app;
}
