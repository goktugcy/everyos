import { Hono } from "hono";
import { z } from "zod";
import {
  LinuxBackupPlanRequestSchema,
  LinuxBackupActionRequestSchema,
  LinuxBackupSelectionSchema,
  LinuxBackupInstallRequestSchema,
} from "@everyos/shared/schemas";
import { ApiError } from "../../http/errors.ts";
import type { AppEnv } from "../../context.ts";
import { agentActor, callAgent } from "../../http/agent.ts";
import { confirmPassword } from "../../http/reauth.ts";
import { parseJsonBody, parseParams } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Id = z.strictObject({ id: z.string().uuid() });
export function linuxBackupRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("backups:restore"));
  app.get("/", async (c) =>
    c.json(await services.linuxBackups.overview(agentActor(requireAuth(c), c.get("client").ip))),
  );
  app.post("/install", requirePermission("system:manage"), async (c) => {
    const input = await parseJsonBody(c, LinuxBackupInstallRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "backups.linux.engine.install");
    if (services.updates.jobs().some((job) => job.status === "running"))
      throw new ApiError(409, "CONFLICT", "Another package operation is running");
    return c.json(
      await services.linuxBackups.installEngine(agentActor(auth, c.get("client").ip)),
      202,
    );
  });
  app.post("/preview", async (c) => {
    const input = await parseJsonBody(c, LinuxBackupSelectionSchema);
    return c.json(await callAgent(c, services, "backups.linux.preview", input));
  });
  app.post("/plans", async (c) => {
    const input = await parseJsonBody(c, LinuxBackupPlanRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "backups.linux.plan");
    return c.json(
      await services.linuxBackups.save(input, agentActor(auth, c.get("client").ip)),
      201,
    );
  });
  app.put("/plans/:id", async (c) => {
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, LinuxBackupPlanRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "backups.linux.plan");
    return c.json(
      await services.linuxBackups.save(input, agentActor(auth, c.get("client").ip), id),
    );
  });
  app.get("/plans/:id/archives", async (c) =>
    c.json(
      await services.linuxBackups.archives(
        parseParams(c, Id).id,
        agentActor(requireAuth(c), c.get("client").ip),
      ),
    ),
  );
  app.post("/plans/:id/jobs", async (c) => {
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, LinuxBackupActionRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "backups.linux.action");
    return c.json(
      await services.linuxBackups.start(
        id,
        input.kind,
        input.archive,
        agentActor(auth, c.get("client").ip),
        input.confirm === true,
      ),
      202,
    );
  });
  app.post("/cancel", async (c) => {
    await parseJsonBody(c, z.strictObject({}));
    return c.json(
      await services.linuxBackups.cancel(agentActor(requireAuth(c), c.get("client").ip)),
    );
  });
  return app;
}
