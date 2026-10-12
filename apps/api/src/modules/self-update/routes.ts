import { Hono } from "hono";
import { z } from "zod";
import { SelfUpdateInstallRequestSchema } from "@everyos/shared/schemas";
import type { AppEnv } from "../../context.ts";
import type { Services } from "../../services.ts";
import { agentActor, callAgent } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { confirmPassword } from "../../http/reauth.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";

export function selfUpdateRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const empty = z.strictObject({});
  app.use("*", requirePermission("system:read"));
  app.get("/", async (c) => {
    parseQuery(c, empty);
    const status = await callAgent(c, services, "release.status", {});
    services.releaseMonitor.observe(status);
    return c.json(status);
  });
  app.post("/check", async (c) => {
    await parseJsonBody(c, empty);
    const status = await callAgent(c, services, "release.check", {});
    services.releaseMonitor.observe(status);
    return c.json(status);
  });
  app.post("/prepare", requirePermission("system:manage"), async (c) => {
    await parseJsonBody(c, empty);
    const auth = requireAuth(c);
    return c.json(
      services.backups.create(
        { apps: [], note: "Pre-update EveryOS safety backup", trigger: "manual" },
        agentActor(auth, c.get("client").ip),
      ),
      202,
    );
  });
  app.post("/install", requirePermission("system:manage"), async (c) => {
    const input = await parseJsonBody(c, SelfUpdateInstallRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "release.install");
    const backup = await services.backups.get(input.backupId);
    if (
      backup.uploaded ||
      !backup.sameKey ||
      backup.createdBy !== auth.user.username ||
      !backup.contents.database ||
      !backup.contents.homes ||
      Date.now() - backup.createdAt > 30 * 60_000
    )
      throw new ApiError(
        409,
        "VALIDATION_FAILED",
        "A fresh local backup of the database and all account homes is required",
      );
    if (!(await services.backups.verify(input.backupId)).ok)
      throw new ApiError(409, "BACKUP_INVALID", "The safety backup could not be verified");
    await services.backups.pin(input.backupId, true);
    const job = await callAgent(c, services, "release.install", {
      version: input.version,
      backupId: input.backupId,
      confirm: true,
    });
    services.audit.record({
      action: "release.install",
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target: job.id,
      details: {
        version: job.version,
        previousVersion: job.previousVersion,
        backupId: job.backupId,
      },
    });
    return c.json(job, 202);
  });
  return app;
}
