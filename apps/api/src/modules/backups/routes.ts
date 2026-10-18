import { PassThrough, Readable } from "node:stream";
import { hostname } from "node:os";
import {
  BackupCreateRequestSchema,
  BackupDownloadQuerySchema,
  BackupDownloadRequestSchema,
  BackupEncryptionRequestSchema,
  BackupIdSchema,
  BackupPassphraseRequestSchema,
  BackupPinRequestSchema,
  BackupSettingsSchema,
  EncryptedUploadIdSchema,
  OffsiteSettingsRequestSchema,
  PasswordConfirmationSchema,
  RestoreRequestSchema,
} from "@everyos/shared/schemas";
import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError, rateLimited } from "../../http/errors.ts";
import { confirmPassword } from "../../http/reauth.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import { sinkTo } from "@everyos/system/archive";
import type { Services } from "../../services.ts";
import { keyFileText } from "./keyring.ts";

const Id = z.strictObject({ id: BackupIdSchema });

const download = (stream: PassThrough, size: number, name: string, type: string) =>
  new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Length": String(size),
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });

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
  const secretTickets = new Map<string, { userId: string; expires: number }>();

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

  /**
   * Raw upload of an archive made by the download below; `Content-Length` is required. An
   * encrypted one answers 202 and waits for its passphrase (`/upload/:uploadId/decrypt`).
   */
  app.post("/upload", restore, async (c) => {
    const length = Number(c.req.header("content-length"));
    if (!c.req.header("content-length") || !Number.isSafeInteger(length) || length <= 0)
      throw new ApiError(411, "VALIDATION_FAILED", "Content-Length is required");
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, "BACKUP_INVALID", "Empty upload");
    const result = await backups.upload(body, length);
    if ("encrypted" in result) return c.json(result, 202);
    audit(c, "upload", result.id, { size: length });
    return c.json(result, 201);
  });

  app.post("/upload/:uploadId/decrypt", restore, async (c) => {
    const { uploadId } = parseParams(c, EncryptedUploadIdSchema);
    const { passphrase } = await parseJsonBody(c, BackupPassphraseRequestSchema);
    const auth = requireAuth(c);
    const key = `user:${auth.user.id}`;
    const limit = services.limiters.sensitiveUser.check(key);
    if (!limit.allowed) throw rateLimited(limit.retryAfterMs);
    try {
      const view = await backups.decryptUpload(uploadId, passphrase);
      audit(c, "upload", view.id, { encrypted: true, keyIncluded: view.keyAvailable });
      return c.json(view, 201);
    } catch (error) {
      if (error instanceof ApiError && error.code === "BACKUP_PASSPHRASE_INVALID")
        services.limiters.sensitiveUser.recordFailure(key);
      throw error;
    }
  });

  app.delete("/upload/:uploadId", restore, async (c) => {
    await backups.discardUpload(parseParams(c, EncryptedUploadIdSchema).uploadId);
    return c.body(null, 204);
  });

  /* ------------------------------------------------ encryption and off-site */

  app.get("/encryption", restore, (c) => c.json(backups.encryption()));

  app.put("/encryption", restore, async (c) => {
    const { passphrase, password } = await parseJsonBody(c, BackupEncryptionRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, password, "backups.encryption");
    const view = await backups.setPassphrase(passphrase, actor(c));
    audit(c, "encryption", null);
    return c.json(view);
  });

  app.delete("/encryption", restore, async (c) => {
    const { password } = await parseJsonBody(c, PasswordConfirmationSchema);
    await confirmPassword(services, c, requireAuth(c), password, "backups.encryption.remove");
    const view = backups.clearPassphrase();
    audit(c, "encryption.remove", null);
    return c.json(view);
  });

  /** "Do I still remember it?" — never changes anything. */
  app.post("/encryption/check", restore, async (c) => {
    const { passphrase } = await parseJsonBody(c, BackupPassphraseRequestSchema);
    const auth = requireAuth(c);
    const key = `user:${auth.user.id}`;
    const limit = services.limiters.sensitiveUser.check(key);
    if (!limit.allowed) throw rateLimited(limit.retryAfterMs);
    const ok = await backups.checkPassphrase(passphrase);
    if (!ok) services.limiters.sensitiveUser.recordFailure(key);
    return c.json({ ok });
  });

  app.get("/offsite", restore, async (c) => c.json(await services.offsite.view()));

  app.put("/offsite", restore, async (c) => {
    const { password, ...request } = await parseJsonBody(c, OffsiteSettingsRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, password, "backups.offsite.settings");
    const view = await services.offsite.update(request, actor(c), c.req.raw.signal);
    audit(c, "offsite.settings", null, {
      kind: request.target?.kind ?? null,
      keep: request.keep,
      auto: request.auto,
    });
    return c.json(view);
  });

  app.post("/offsite/test", restore, async (c) => {
    await services.offsite.test(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]));
    return c.json({ ok: true });
  });

  /** Step 1 of downloading the server secret: re-authenticate, receive a one-minute link. */
  app.post("/secret-key", restore, async (c) => {
    const { password } = await parseJsonBody(c, PasswordConfirmationSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, password, "backups.secret-key");
    const ticket = randomBytes(24).toString("base64url");
    secretTickets.set(ticket, { userId: auth.user.id, expires: services.now() + 60_000 });
    return c.json({ url: `/api/backups/secret-key?ticket=${ticket}` });
  });

  app.get("/secret-key", restore, (c) => {
    const { ticket } = parseQuery(c, BackupDownloadQuerySchema);
    const auth = requireAuth(c);
    const entry = secretTickets.get(ticket);
    secretTickets.delete(ticket);
    for (const [key, value] of secretTickets)
      if (value.expires < services.now()) secretTickets.delete(key);
    if (!entry || entry.userId !== auth.user.id || entry.expires < services.now())
      throw new ApiError(403, "FORBIDDEN", "The download link is invalid or expired");
    const text = Buffer.from(keyFileText(backups.secretKey()));
    audit(c, "secret-key.download", null);
    const stream = new PassThrough();
    stream.end(text);
    const host =
      hostname()
        .replace(/[^A-Za-z0-9-]/g, "")
        .slice(0, 32) || "everyos";
    return download(stream, text.length, `everyos-${host}-secret.key`, "application/octet-stream");
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

  app.post("/:id/offsite", restore, (c) => {
    const { id } = parseParams(c, Id);
    return c.json(backups.offsiteCopy(id, actor(c)), 202);
  });

  app.post("/:id/restore", restore, async (c) => {
    const { id } = parseParams(c, Id);
    const input = await parseJsonBody(c, RestoreRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, input.password, "backups.restore");
    const job = backups.restore(
      id,
      { settings: input.settings, apps: input.apps, homes: input.homes },
      actor(c),
    );
    return c.json(job, 202);
  });

  /** Step 1 of a download: re-authenticate and receive a single-use link valid for a minute. */
  app.post("/:id/download", restore, async (c) => {
    const { id } = parseParams(c, Id);
    const { password, encrypted } = await parseJsonBody(c, BackupDownloadRequestSchema);
    const auth = requireAuth(c);
    await confirmPassword(services, c, auth, password, "backups.download");
    const ticket = await backups.issueTicket(id, auth.user.id, encrypted);
    return c.json({ url: `/api/backups/${id}/download?ticket=${ticket}` });
  });

  app.get("/:id/download", restore, async (c) => {
    const { id } = parseParams(c, Id);
    const { ticket } = parseQuery(c, BackupDownloadQuerySchema);
    const auth = requireAuth(c);
    const redeemed = backups.redeemTicket(ticket, id, auth.user.id);
    if (!redeemed) throw new ApiError(403, "FORBIDDEN", "The download link is invalid or expired");
    const archive = await backups.download(id, redeemed);
    audit(c, "download", id, { size: archive.size, encrypted: redeemed.encrypted });
    const stream = new PassThrough();
    archive
      .write(sinkTo(stream))
      .then(() => stream.end())
      .catch((error: unknown) => {
        services.logger.warn("Backup download failed", { id, error });
        stream.destroy(error as Error);
      });
    return download(
      stream,
      archive.size,
      archive.name,
      redeemed.encrypted ? "application/octet-stream" : "application/x-tar",
    );
  });

  return app;
}
