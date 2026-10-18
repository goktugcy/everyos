import type { TwoFactorPolicyView } from "@everyos/shared";
import { TwoFactorPolicyRequestSchema } from "@everyos/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import {
  policyCovers,
  readTwoFactorPolicy,
  writeTwoFactorPolicy,
} from "../auth/two-factor-policy.ts";

/** Instance-wide security settings that only administrators change. */
export function securityRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("users:manage"));

  function twoFactorView(): TwoFactorPolicyView {
    const required = readTwoFactorPolicy(services.db);
    return {
      required,
      pending: services.users
        .list()
        .filter((user) => !user.disabled && !user.totpEnabled && policyCovers(required, user))
        .map(({ id, username, displayName }) => ({ id, username, displayName })),
    };
  }

  app.get("/two-factor", (c) => c.json(twoFactorView()));

  app.put("/two-factor", async (c) => {
    const auth = requireAuth(c);
    const { required } = await parseJsonBody(c, TwoFactorPolicyRequestSchema);
    // Requiring it from your own role first needs your own second factor, so the change never
    // sends the administrator making it to the setup screen.
    if (!auth.user.totpEnabled && policyCovers(required, auth.user))
      throw new ApiError(409, "TWO_FACTOR_SELF_FIRST", "Set up your own two-factor first");
    const previous = readTwoFactorPolicy(services.db);
    writeTwoFactorPolicy(services.db, required, services.now());
    services.audit.record({
      action: "security.two-factor",
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      details: { from: previous, to: required },
    });
    return c.json(twoFactorView());
  });

  return app;
}
