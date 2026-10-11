import { PassThrough, Readable } from "node:stream";
import {
  BackupCreateRequestSchema,
  BackupDownloadQuerySchema,
  BackupDownloadRequestSchema,
  BackupIdSchema,
  BackupPinRequestSchema,
  BackupSettingsSchema,
  RestoreRequestSchema,
} from "@otuken/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { confirmPassword } from "../../http/reauth.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import { sinkTo } from "@otuken/system/archive";
import type { Services } from "../../services.ts";

const Id = z.strictObject({ id: BackupIdSchema });

/**
 * Backups (docs/backups.md). Creating and managing backups needs
 * `backups:manage`; restoring, downloading and uploading them needs
 * `backups:restore` (administrators) plus the current password, because an
 * archive holds every account's data.
 */
export function backupRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const backups = services.backups;
  app.use("*", requirePermission("backups:manage"));
  const restore = requirePermission("backups:restore");

  const actor = (c: Context<AppEnv>) => agentActor(requireAuth(c), c.get("client").ip);
  const audit = (
    c: Context<AppEnv>,
    action: string,
    target: string | null,
    details?: Record<string, unknown>,
  ) => {
    const auth = requireAuth(c);
    services.audit.record({
      action: `backups.${action}`,
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target,
      ...(details ? { details } : {}),
    });
  };

  app.get("/", async (c) => c.json(await backups.overview(actor(c))));

  app.post("/", async (c) => {
    const input = await parseJsonBody(c, BackupCreateRequestSchema);
    const job = backups.create(
      { apps: input.apps, ...(input.note ? { note: input.note } : {}), trigger: "manual" },
      actor(c),
    );
    return c.json(job, 202);
  });

  /** Only the job state (cheap, for live indicators). */
  app.get("/job", (c) => c.json({ job: backups.job(), lastJob: backups.lastJob() }));

  app.post("/cancel", (c) => {
    const cancelled = backups.cancel();
    if (cancelled) audit(c, "cancel", null);
    return c.json({ cancelled });
  });

  app.put("/settings", async (c) => {
    const settings = backups.updateSettings(await parseJsonBody(c, BackupSettingsSchema));
    audit(c, "settings", null, { keep: settings.keep, appData: settings.appData });
    return c.json(settings);
  });

  /** Raw upload of an archive made by the download below; `Content-Length` is required. */
  app.post("/upload", restore, async (c) => {
    const length = Number(c.req.header("content-length"));
    if (!c.req.header("content-length") || !Number.isSafeInteger(length) || length <= 0)
      throw new ApiError(411, "VALIDATION_FAILED", "Content-Length is required");
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, "BACKUP_INVALID", "Empty upload");
    const view = await backups.upload(body, length);
    audit(c, "upload", view.id, { size: length });
    return c.json(view, 201);
  });

  app.get("/:id", async (c) => c.json(await backups.get(parseParams(c, Id).id)));

  app.post("/:id/verify", async (c) => {
    const { id } = parseParams(c, Id);
    const verification = await backups.verify(id);
    audit(c, "verify", id, {
      ok: verification.ok,
      ...(verification.error ? { error: verification.error } : {}),
    });
    return c.json(verification);
  });

  app.put("/:id/pin", async (c) => {
    const { id } = parseParams(c, Id);
    const { pinned } = await parseJsonBody(c, BackupPinRequestSchema);
    const view = await backups.pin(id, pinned);
    audit(c, pinned ? "pin" : "unpin", id);
    return c.json(view);
  });

  app.delete("/:id", async (c) => {
    const { id } = parseParams(c, Id);
    await backups.remove(id);
    audit(c, "delete", id);
    return c.body(null, 204);
  });

  app.get("/:id/preview", restore, async (c) =>
    c.json(await backups.preview(parseParams(c, Id).id)),
  );

  app.post("/:id/restore", restore, async (c) => {
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, RestoreRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "backups.restore");
    const job = backups.restore(id, { settings: input.settings, apps: input.apps }, actor(c));
    return c.json(job, 202);
  });

  /** Step 1 of a download: re-authenticate and receive a single-use link valid for a minute. */
  app.post("/:id/download", restore, async (c) => {
    const { id } = parseParams(c, Id);
    const { password } = await parseJsonBody(c, BackupDownloadRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, password, "backups.download");
    const ticket = await backups.issueTicket(id, auth.user.id);
    return c.json({ url: `/api/backups/${id}/download?ticket=${ticket}` });
  });

  app.get("/:id/download", restore, async (c) => {
    const { id } = parseParams(c, Id);
    const { ticket } = parseQuery(c, BackupDownloadQuerySchema);
    const auth = requireAuth(c);
    if (!backups.redeemTicket(ticket, id, auth.user.id))
      throw new ApiError(403, "FORBIDDEN", "The download link is invalid or expired");
    const download = await backups.download(id);
    audit(c, "download", id, { size: download.size });
    const stream = new PassThrough();
    download
      .write(sinkTo(stream))
      .then(() => stream.end())
      .catch((error: unknown) => {
        services.logger.warn("Backup download failed", { id, error });
        stream.destroy(error as Error);
      });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${download.name}"`,
        "Content-Length": String(download.size),
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });

  return app;
}
