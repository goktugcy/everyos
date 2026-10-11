import { DEFAULT_LOCALE } from "@everyos/shared";
import {
  CreateUserRequestSchema,
  ResetPasswordRequestSchema,
  UpdateUserRequestSchema,
} from "@everyos/shared/schemas";
import { Hono } from "hono";
import type { AppEnv, AuthState } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { assertPasswordPolicy } from "../auth/password-policy.ts";
import { toAdminUserView, type User } from "./user-repository.ts";

export function userRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { users, audit, sessions } = services;
  app.use("*", requirePermission("users:manage"));

  const actor = (auth: AuthState) => ({ userId: auth.user.id, username: auth.user.username });

  function target(id: string): User {
    const user = users.findById(id);
    if (!user) throw notFound("User");
    return user;
  }

  /** True when removing admin rights from `user` would leave no active administrator. */
  function isLastActiveAdmin(user: User): boolean {
    return user.role === "admin" && !user.disabled && users.countActiveAdmins() <= 1;
  }

  app.get("/", (c) => c.json({ users: users.list().map(toAdminUserView) }));

  app.post("/", async (c) => {
    const auth = requireAuth(c);
    const body = await parseJsonBody(c, CreateUserRequestSchema);
    if (users.findByUsername(body.username))
      throw new ApiError(409, "USER_USERNAME_TAKEN", "Username already exists");
    assertPasswordPolicy(body.password, body.username);
    const created = users.create({
      username: body.username,
      displayName: body.displayName,
      passwordHash: await services.passwords.hash(body.password),
      role: body.role,
      locale: body.locale ?? DEFAULT_LOCALE,
    });
    audit.record({
      action: "users.create",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
      target: created.username,
      details: { role: created.role },
    });
    return c.json(toAdminUserView(created), 201);
  });

  app.patch("/:id", async (c) => {
    const auth = requireAuth(c);
    const user = target(c.req.param("id"));
    const body = await parseJsonBody(c, UpdateUserRequestSchema);
    const changesPrivileges =
      (body.role !== undefined && body.role !== user.role) || body.disabled === true;
    if (user.id === auth.user.id && changesPrivileges) {
      throw new ApiError(
        400,
        "USER_CANNOT_MODIFY_SELF",
        "Cannot change your own role or disable yourself",
      );
    }
    const demotes = (body.role !== undefined && body.role !== "admin") || body.disabled === true;
    if (demotes && isLastActiveAdmin(user)) {
      throw new ApiError(
        409,
        "USER_LAST_ADMIN",
        "The last active administrator cannot be demoted or disabled",
      );
    }
    services.db.transaction(() => {
      users.update(user.id, {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      });
      if (body.disabled === true) sessions.revokeAllForUser(user.id);
    });
    audit.record({
      action: "users.update",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
      target: user.username,
      details: { ...body },
    });
    return c.json(toAdminUserView(users.findById(user.id)!));
  });

  app.post("/:id/password", async (c) => {
    const auth = requireAuth(c);
    const user = target(c.req.param("id"));
    const body = await parseJsonBody(c, ResetPasswordRequestSchema);
    assertPasswordPolicy(body.newPassword, user.username);
    users.setPasswordHash(user.id, await services.passwords.hash(body.newPassword));
    const revoked = sessions.revokeAllForUser(
      user.id,
      user.id === auth.user.id ? auth.session.id : null,
    );
    audit.record({
      action: "users.password.reset",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
      target: user.username,
      details: { revokedSessions: revoked },
    });
    return c.body(null, 204);
  });

  app.post("/:id/totp/reset", (c) => {
    const auth = requireAuth(c);
    const user = target(c.req.param("id"));
    if (user.id === auth.user.id) {
      throw new ApiError(
        400,
        "USER_CANNOT_MODIFY_SELF",
        "Use the account settings to change your own two-step verification",
      );
    }
    users.disableTotp(user.id);
    audit.record({
      action: "users.totp.reset",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
      target: user.username,
    });
    return c.body(null, 204);
  });

  app.delete("/:id", async (c) => {
    const auth = requireAuth(c);
    const user = target(c.req.param("id"));
    if (user.id === auth.user.id)
      throw new ApiError(400, "USER_CANNOT_MODIFY_SELF", "Cannot delete your own account");
    if (isLastActiveAdmin(user))
      throw new ApiError(409, "USER_LAST_ADMIN", "The last active administrator cannot be deleted");
    users.delete(user.id);
    await services.wallpapers.deleteAllForUser(user.id);
    audit.record({
      action: "users.delete",
      outcome: "success",
      actor: actor(auth),
      ip: c.get("client").ip,
      target: user.username,
    });
    return c.body(null, 204);
  });

  return app;
}
