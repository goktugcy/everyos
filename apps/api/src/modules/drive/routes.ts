import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { DRIVE_ROOT, DRIVE_SHARED } from "@everyos/shared";
import {
  DriveClientInputSchema,
  DriveCompleteSchema,
  DriveConnectSchema,
  DriveFolderCreateSchema,
  DriveIdSchema,
  DriveListQuerySchema,
  DriveRenameSchema,
  DriveTransferRequestSchema,
  DriveUploadQuerySchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { fileViewFor } from "../files/file-view.ts";
import { driveDownloadTask, driveUploadTask } from "./drive-transfers.ts";

const Empty = z.strictObject({});
const Id = z.strictObject({ id: DriveIdSchema });

function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Google Drive (docs/drive.md): the administrator's client, each person's own Drive. */
export function driveRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const drive = services.drive;
  const actor = (c: Context<AppEnv>) => agentActor(requireAuth(c), c.get("client").ip);
  const me = (c: Context<AppEnv>) => requireAuth(c).user.id;
  const files = (c: Context<AppEnv>, background = false) => {
    const auth = requireAuth(c);
    return fileViewFor(
      services,
      { user: auth.user, permissions: auth.permissions, actor: actor(c) },
      // A transfer outlives the request that started it.
      { signal: background ? undefined : c.req.raw.signal, logger: c.get("logger") },
    );
  };
  const manage = requirePermission("system:manage");
  const read = requirePermission("files:read");
  const write = requirePermission("files:write");

  app.get("/client", manage, (c) => {
    parseQuery(c, Empty);
    return c.json(drive.client());
  });
  app.put("/client", manage, async (c) => {
    parseQuery(c, Empty);
    return c.json(drive.setClient(await parseJsonBody(c, DriveClientInputSchema), actor(c)));
  });
  /** Removing the client also disconnects everyone's Drive. */
  app.delete("/client", manage, async (c) => {
    parseQuery(c, Empty);
    await parseJsonBody(c, z.strictObject({ confirm: z.literal(true) }));
    drive.clearClient(actor(c));
    return c.body(null, 204);
  });

  app.get("/account", read, async (c) => {
    parseQuery(c, Empty);
    return c.json(await drive.account(me(c)));
  });
  app.post("/connect", read, async (c) => {
    parseQuery(c, Empty);
    const { redirectUri } = await parseJsonBody(c, DriveConnectSchema);
    return c.json(drive.begin(me(c), redirectUri));
  });
  app.post("/connect/complete", read, async (c) => {
    parseQuery(c, Empty);
    const { code, state } = await parseJsonBody(c, DriveCompleteSchema);
    return c.json(await drive.complete(me(c), code, state, actor(c)));
  });
  app.delete("/account", read, async (c) => {
    parseQuery(c, Empty);
    await drive.disconnect(me(c), actor(c));
    return c.body(null, 204);
  });

  app.get("/files", read, async (c) => {
    const { folder, pageToken } = parseQuery(c, DriveListQuerySchema);
    return c.json(await drive.list(me(c), folder, pageToken));
  });
  app.post("/folders", write, async (c) => {
    parseQuery(c, Empty);
    const { parent, name } = await parseJsonBody(c, DriveFolderCreateSchema);
    return c.json(await drive.createFolder(me(c), parent, name), 201);
  });
  app.patch("/files/:id", write, async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    const { name } = await parseJsonBody(c, DriveRenameSchema);
    return c.json(await drive.rename(me(c), id, name));
  });
  app.post("/files/:id/trash", write, async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    await parseJsonBody(c, Empty);
    await drive.trash(me(c), id);
    return c.body(null, 204);
  });

  /** A Drive file to the browser (Google Docs files exported). */
  app.get("/files/:id/download", read, async (c) => {
    parseQuery(c, Empty);
    const { id } = parseParams(c, Id);
    const entry = await drive.metadata(me(c), id);
    const download = await drive.download(me(c), entry, c.req.raw.signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": disposition(download.name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };
    if (download.sizeBytes !== null) headers["Content-Length"] = String(download.sizeBytes);
    return new Response(Readable.toWeb(download.stream) as ReadableStream, { headers });
  });

  /** Browser upload into a Drive folder, streamed through; `Content-Length` is required. */
  app.post("/upload", write, async (c) => {
    const { parent, name } = parseQuery(c, DriveUploadQuerySchema);
    const length = Number(c.req.header("content-length"));
    if (!c.req.header("content-length") || !Number.isSafeInteger(length) || length < 0)
      throw new ApiError(411, "VALIDATION_FAILED", "Content-Length is required");
    const body = c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() });
    const entry = await drive.upload(
      me(c),
      parent,
      name,
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      length,
      c.req.raw.signal,
    );
    services.audit.record({
      action: "drive.upload",
      outcome: "success",
      actor: { userId: requireAuth(c).user.id, username: requireAuth(c).user.username },
      ip: c.get("client").ip,
      details: { size: length },
    });
    return c.json(entry, 201);
  });

  /** Copies between Drive and an EveryOS location, as a transfer with live progress. */
  app.post("/transfers", write, async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, DriveTransferRequestSchema);
    const auth = requireAuth(c);
    const userId = auth.user.id;
    const view = files(c);
    const roots = await view.roots(true);
    const locationLabel = (root: string, path: string) => {
      const found = roots.find((candidate) => candidate.id === root);
      if (!found) throw new ApiError(404, "NOT_FOUND", "Location not found");
      return [found.name, ...path.split("/").filter(Boolean)].join(" › ");
    };
    const driveLabel = async (id: string) =>
      id === DRIVE_ROOT
        ? "Google Drive"
        : `Google Drive › ${(await drive.metadata(userId, id)).name}`;
    const withAccess = <T>(run: () => Promise<T>) => services.files.withAccess(userId, run);
    const background = () => files(c, true);
    let task;
    if (input.source.kind === "drive" && input.destination.kind === "files") {
      if (input.source.id === DRIVE_ROOT || input.source.id === DRIVE_SHARED)
        throw new ApiError(400, "VALIDATION_FAILED", "Choose files or folders to copy");
      const destination = input.destination;
      const target = await view.properties(destination.root, destination.path);
      if (target.type !== "directory")
        throw new ApiError(400, "VALIDATION_FAILED", "The destination must be a folder");
      const source = await drive.metadata(userId, input.source.id);
      if (!source.downloadable)
        throw new ApiError(409, "DRIVE_NOT_DOWNLOADABLE", "This file cannot be downloaded");
      task = driveDownloadTask({
        drive,
        files: background,
        userId,
        source,
        destination: { root: destination.root, path: destination.path },
        from: "Google Drive",
        to: locationLabel(destination.root, destination.path),
        withAccess,
      });
    } else if (input.source.kind === "files" && input.destination.kind === "drive") {
      const { root, path } = input.source;
      if (input.destination.id === DRIVE_SHARED)
        throw new ApiError(400, "VALIDATION_FAILED", "Files are uploaded to My Drive");
      const item = await view.properties(root, path);
      if (!path || (item.type !== "file" && item.type !== "directory"))
        throw new ApiError(400, "VALIDATION_FAILED", "Only files and folders can be copied");
      task = driveUploadTask({
        drive,
        files: background,
        userId,
        source: { root, path, name: item.name, type: item.type, size: item.size },
        parent: input.destination.id,
        from: locationLabel(root, path),
        to: await driveLabel(input.destination.id),
        withAccess,
      });
    } else throw new ApiError(400, "VALIDATION_FAILED", "Unsupported transfer");
    const started = services.transfers.start(userId, task);
    services.audit.record({
      action: `drive.${task.direction}`,
      target: started.id,
      outcome: "success",
      actor: { userId, username: auth.user.username },
      ip: c.get("client").ip,
      details: {
        name: task.name,
        root:
          input.source.kind === "files"
            ? input.source.root
            : input.destination.kind === "files"
              ? input.destination.root
              : "",
      },
    });
    return c.json(started, 202);
  });
  return app;
}
