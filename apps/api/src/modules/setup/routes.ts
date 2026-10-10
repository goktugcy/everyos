import { SetupRequestSchema } from "@otuken/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { ApiError, rateLimited } from "../../http/errors.ts";
import { parseJsonBody } from "../../http/validation.ts";
import type { Services } from "../../services.ts";
import { assertPasswordPolicy } from "../auth/password-policy.ts";
import { startSession } from "../auth/session-cookie.ts";

export function setupRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/setup", async (c) => {
    // Once an account exists the endpoint is permanently closed.
    if (!services.setup.isSetupRequired()) {
      throw new ApiError(409, "SETUP_ALREADY_COMPLETED", "Setup has already been completed");
    }
    const client = c.get("client");
    const limiterKey = `ip:${client.ip}`;
    const decision = services.limiters.setupIp.check(limiterKey);
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);

    const body = await parseJsonBody(c, SetupRequestSchema);
    if (!services.setup.verifyToken(body.setupToken)) {
      services.limiters.setupIp.recordFailure(limiterKey);
      services.audit.record({
        action: "setup.complete",
        outcome: "failure",
        ip: client.ip,
        details: { reason: "token" },
      });
      throw new ApiError(403, "SETUP_TOKEN_INVALID", "Invalid setup token");
    }
    assertPasswordPolicy(body.password, body.username);
    const passwordHash = await services.passwords.hash(body.password);

    // Re-check inside a write transaction so two concurrent requests cannot
    // both create an administrator.
    const admin = services.db.transaction(() => {
      if (services.users.count() > 0) return null;
      return services.users.create({
        username: body.username,
        displayName: body.displayName,
        passwordHash,
        role: "admin",
        locale: body.locale,
      });
    });
    if (!admin)
      throw new ApiError(409, "SETUP_ALREADY_COMPLETED", "Setup has already been completed");

    services.setup.markCompleted();
    services.limiters.setupIp.reset(limiterKey);
    const session = startSession(c, services, admin);
    services.audit.record({
      action: "setup.complete",
      outcome: "success",
      actor: { userId: admin.id, username: admin.username },
      ip: client.ip,
    });
    return c.json(session, 201);
  });

  return app;
}
